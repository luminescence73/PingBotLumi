import { ChannelType } from "discord.js";
import { client } from "../runtime/client.js";
import { getGuild, resolveAshenGuild } from "./access.js";
import { dbGetState, dbSetState } from "../runtime/database.js";

let memberGuildPingsChannelId = null;

export let staffChatKeeperId = null;

function canonicalSidebarKey(value) {
  return String(value || "").normalize("NFKC")
    .toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function sidebarChannelGroup(guild, channelName, parentKey) {
  const parent = guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildCategory &&
    canonicalSidebarKey(channel.name).includes(parentKey)
  );
  if (!parent) return [];

  return [...guild.channels.cache.values()]
    .filter(channel =>
      channel.type === ChannelType.GuildText &&
      channel.parentId === parent.id &&
      canonicalSidebarKey(channel.name) === canonicalSidebarKey(channelName)
    )
    .sort((a, b) =>
      a.id === b.id ? 0 : (BigInt(a.id) < BigInt(b.id) ? -1 : 1)
    );
}

// Fail closed for channels with human messages, pinned history, threads,
// missing permissions, or history too long to inspect completely.
async function inspectDuplicateSidebarChannel(channel) {
  try {
    const active = await channel.threads.fetchActive();
    if (active.threads.size) return "contains active threads";
    for (const type of ["public", "private"]) {
      const archived = await channel.threads.fetchArchived({ type, limit: 1 });
      if (archived.threads.size) return "contains archived threads";
    }
  } catch (error) {
    return "could not verify threads: " + error.message;
  }

  let before = null;
  let seen = 0;
  for (;;) {
    let batch;
    try {
      batch = await channel.messages.fetch({
        limit: 100,
        ...(before ? { before } : {})
      });
    } catch (error) {
      return "could not verify messages: " + error.message;
    }

    for (const message of batch.values()) {
      if (message.author?.id !== client.user.id) return "contains non-Vestra messages";
      if (message.pinned) return "contains pinned messages";
    }

    seen += batch.size;
    if (batch.size < 100) return null;
    if (seen >= 500) return "contains over 500 messages";
    before = batch.last()?.id;
    if (!before) return "message history could not be paginated";
  }
}

export async function cleanupDuplicateSidebarChannels(guildOverride = null) {
  const guild = await resolveAshenGuild(guildOverride);
  if (!guild) return;
  await guild.channels.fetch();

  const groups = [
    { key: "member", name: "guild-pings", parent: "swordxstaffguild" },
    { key: "staff", name: "staff-chat", parent: "ashencommand" }
  ];

  const stateKey = "ashen_duplicate_sidebar_cleanup_2026_11_09_v1";
  const previous = await dbGetState(stateKey);
  const report = { retained: [], deleted: [], skipped: [], errors: [] };

  for (const group of groups) {
    const matches = sidebarChannelGroup(guild, group.name, group.parent);
    if (!matches.length) {
      report.skipped.push(group.name + ": no existing channel found in expected category");
      continue;
    }

    let keeper = matches.find(channel =>
      channel.id === previous?.keepers?.[group.key]
    ) || matches[0];

    if (!previous?.completed && matches.length > 1) {
      const audits = [];
      for (const channel of matches) {
        const reason = await inspectDuplicateSidebarChannel(channel);
        audits.push({ channel, reason });
      }

      // Prefer a channel with real/valuable history as keeper.
      const protectedHistory = audits.filter(item => item.reason !== null);
      if (protectedHistory.length) keeper = protectedHistory[0].channel;

      for (const item of audits) {
        if (item.channel.id === keeper.id) continue;
        if (item.reason) {
          report.skipped.push(item.channel.name + " (" + item.channel.id +
            "): " + item.reason);
          continue;
        }

        try {
          await item.channel.delete("Remove empty/Vestra-only duplicate " +
            group.name + "; preserve the canonical channel and staff messages");
          report.deleted.push(item.channel.name + " (" + item.channel.id + ")");
        } catch (error) {
          report.errors.push(group.name + " (" + item.channel.id + "): " + error.message);
        }
      }
    }

    report.retained.push(group.name + " (" + keeper.id + ")");
    if (group.key === "member") memberGuildPingsChannelId = keeper.id;
    else staffChatKeeperId = keeper.id;
  }

  if (!previous?.completed) {
    // Never run a destructive sweep again on a later deployment/restart.
    await dbSetState(stateKey, {
      completed: true,
      keepers: { member: memberGuildPingsChannelId, staff: staffChatKeeperId },
      ...report
    });
  }

  console.log("🧹 Ashen duplicate-channel cleanup:", JSON.stringify(report));
  if (report.skipped.length) console.warn("⚠️ Review retained duplicates:", report.skipped);
  if (report.errors.length) console.error("❌ Duplicate cleanup errors:", report.errors);
}

export async function getMemberGuildPingsChannel() {
  const guild = getGuild();
  if (!guild) return null;

  if (memberGuildPingsChannelId) {
    const current = await guild.channels.fetch(memberGuildPingsChannelId).catch(() => null);
    if (current?.type === ChannelType.GuildText) return current;
  }

  await guild.channels.fetch();
  const first = sidebarChannelGroup(guild, "guild-pings", "swordxstaffguild")[0];
  if (!first) return null;
  memberGuildPingsChannelId = first.id;
  return first;
}
