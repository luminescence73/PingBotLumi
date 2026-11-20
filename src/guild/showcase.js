import { ChannelType, PermissionFlagsBits } from "discord.js";
import { ONBOARDING_COMPLETE, commandStaffRoleIds, isStaff } from "./access.js";
import { limitText } from "../shared/discord.js";
import { client } from "../runtime/client.js";

function getAshenMembersChannel(guild) {
  // Public showcase/community highlights channel. Keep thread automation here.
  return guild?.channels?.cache?.find(
    ch => ch.type === ChannelType.GuildText &&
      (
        ch.name.toLowerCase().includes("community-highlights") ||
        ch.name.toLowerCase().includes("ashen-showcase") ||
        ch.name.toLowerCase().includes("ashen-members")
      )
  ) || null;
}

export function getGuildMembersDirectoryChannel(guild) {
  return guild?.channels?.cache?.find(
    ch => ch.type === ChannelType.GuildText && ch.name === "guild-members"
  ) || null;
}

// Only Ashen staff may publish in the main showcase; other members may
// view it, react, and write in its discussion threads.
export async function enforceAshenMembersStaffOnly(guild) {
  const channel = getAshenMembersChannel(guild);
  if (!channel) {
    console.warn("⚠️ #ashen-members unavailable: permissions unchanged.");
    return false;
  }

  const me = guild.members.me || await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    console.error("❌ Vestra needs Manage Roles to set showcase permissions.");
    return false;
  }

  const denyPosting = {
    SendMessages: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false
  };

  await channel.permissionOverwrites.edit(guild.roles.everyone, {
    ...denyPosting,
    ViewChannel: false,
    ReadMessageHistory: false,
    AddReactions: false,
    SendMessagesInThreads: false
  }, { reason: "Community highlights require completed onboarding" });

  await channel.permissionOverwrites.edit(ONBOARDING_COMPLETE, {
    ViewChannel: true,
    ReadMessageHistory: true,
    SendMessages: false,
    AddReactions: true,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
    SendMessagesInThreads: true
  }, { reason: "Onboarded members may view, react, and discuss highlights" });

  for (const id of commandStaffRoleIds(guild)) {
    const role = guild.roles.cache.get(id);
    if (!role) {
      console.warn("⚠️ Ashen staff role missing: " + id);
      continue;
    }
    await channel.permissionOverwrites.edit(role, {
      SendMessages: true,
      CreatePublicThreads: true,
      SendMessagesInThreads: true
    }, { reason: "Authorize staff showcases" });
  }

  // Remove older direct channel posting exceptions for non-staff.
  for (const overwrite of [...channel.permissionOverwrites.cache.values()]) {
    if (overwrite.id === guild.id ||
        overwrite.id === me.id ||
        commandStaffRoleIds(guild).includes(overwrite.id)) continue;

    const canPost = overwrite.allow.has(PermissionFlagsBits.SendMessages) ||
      overwrite.allow.has(PermissionFlagsBits.CreatePublicThreads) ||
      overwrite.allow.has(PermissionFlagsBits.CreatePrivateThreads);
    if (!canPost) continue;

    if (overwrite.type === 1) {
      const member = await guild.members.fetch(overwrite.id).catch(() => null);
      if (member && isStaff(member)) continue;
    }
    await channel.permissionOverwrites.edit(overwrite.id, denyPosting, {
      reason: "Remove non-staff showcase posting exceptions"
    });
  }

  // Allow Vestra to manage the channel panel and staff discussion threads.
  await channel.permissionOverwrites.edit(me, {
    SendMessages: true,
    SendMessagesInThreads: true,
    CreatePublicThreads: true,
    ManageThreads: true,
    ReadMessageHistory: true
  }, { reason: "Vestra showcase management" });

  console.log("✅ Ashen Members: staff-only posts, open discussion threads.");
  return true;
}

function ashenPostInfoText(message) {
  const rawCaption = (message.content || "").trim();
  const creditPattern = /(?:^|[\s.!?])(?:🎨\s*)?(?:credits?(?:\s+to|\s+by)?|art(?:work)?\s+by|illustration\s+by|created\s+by|made\s+by|artist)\s*[:\-–]?\s*(.+)$/im;
  const match = creditPattern.exec(rawCaption);
  const credits = match?.[1]?.trim() || "Not specified";
  const caption = match ? rawCaption.replace(match[0], "").trim() : rawCaption;
  const attachmentCount = message.attachments?.size || 0;

  return [
    "## DISCUSSION",
    "All discussion belongs in this thread so #community-highlights stays clean.",
    "",
    `**Posted by:** <@${message.author.id}>`,
    `**Creator credit:** ${limitText(credits, 500)}`,
    `**Posted:** <t:${Math.floor(message.createdTimestamp / 1000)}:f>`,
    `**Attachments:** ${attachmentCount ? attachmentCount + " file" + (attachmentCount === 1 ? "" : "s") : "None"}`,
    `**Original post:** [View original](${message.url})`,
    caption ? `**Caption:** ${limitText(caption, 1000)}` : null
  ].filter(Boolean).join("\n");
}

function ashenDiscussionIntroduction(channelId) {
  return "## DISCUSSION\n" +
    "All discussion belongs in this thread. Keep <#" + channelId +
    "> reserved for staff showcases.";
}

// Reuse Vestra's existing discussion introduction and keep every user message
// and reaction untouched. The embedded details belong to Vestra, not the
// original user's message (which Discord bots cannot edit).
async function upsertAshenDiscussionDetails(message, thread) {
  if (!thread?.isThread?.()) throw new Error("Discussion thread is unavailable.");

  const wasArchived = thread.archived === true;
  if (wasArchived) {
    await thread.setArchived(false, "Updating creator credits and post details");
  }

  try {
    const recent = await thread.messages.fetch({ limit: 100 });
    const footerTag = "Vestra • Ashen Members • " + message.id;
    const detailsMessage = recent.find(m =>
      m.author?.id === client.user?.id &&
      m.embeds?.some(e => e.footer?.text === footerTag)
    );
    const oldIntroduction = recent.find(m =>
      m.author?.id === client.user?.id &&
      (m.content?.startsWith("## 💬 Discuss This Post") || m.content?.startsWith("## DISCUSSION"))
    );
    const existing = detailsMessage || oldIntroduction;
    const data = { content: ashenPostInfoText(message), embeds: [], allowedMentions: { parse: [] } };

    if (existing) {
      await existing.edit(data);
      return "updated";
    }

    await thread.send({
      content: ashenDiscussionIntroduction(message.channel.id),
      ...data
    });
    return "created";
  } finally {
    if (wasArchived && !thread.archived) {
      await thread.setArchived(true, "Restore original discussion archive status")
        .catch(error => console.warn("⚠️ Could not rearchive discussion " + thread.id + ": " + error.message));
    }
  }
}

export async function refreshAshenMembersPostInfo(message) {
  const channel = getAshenMembersChannel(message.guild);
  if (!channel || message.channel.id !== channel.id || !message.hasThread) return;

  const thread = message.thread ||
    await message.guild.channels.fetch(message.id).catch(() => null);
  if (!thread?.isThread?.()) return;

  // On post edits, refresh the credit details in the existing thread.
  await upsertAshenDiscussionDetails(message, thread).catch(error => {
    console.error("❌ Could not refresh Ashen post credits:", error.message);
  });
}

export async function ensureAshenMembersDiscussion(message) {
  if (!message?.guild || message.author?.bot || message.webhookId) {
    return false;
  }

  const showcaseChannel = getAshenMembersChannel(message.guild);

  if (!showcaseChannel || message.channel.id !== showcaseChannel.id) {
    return false;
  }

  const member = message.member ||
    await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!isStaff(member)) {
    // Permissions should block this; the guard catches older exceptions.
    console.warn("⚠️ Non-staff showcase post rejected: " + message.author.id);
    await message.delete().catch(error =>
      console.error("❌ Could not remove unauthorized post:", error.message)
    );
    return true;
  }

  // If someone replies in the main feed, move the discussion into the
  // original showcase post's thread instead of letting replies pile up.
  if (message.reference?.messageId) {
    const sourceMessage = await showcaseChannel.messages
      .fetch(message.reference.messageId)
      .catch(() => null);

    if (sourceMessage?.hasThread && sourceMessage.thread) {
      const attachmentText = [...message.attachments.values()]
        .map(attachment => attachment.url)
        .join("\n");

      const movedText = [
        `**<@${message.author.id}> replied:**`,
        message.content || "",
        attachmentText
      ]
        .filter(Boolean)
        .join("\n");

      await sourceMessage.thread
        .send({
          content: movedText,
          allowedMentions: {
            users: [message.author.id]
          }
        })
        .catch(() => null);

      await message.delete().catch(() => {});

      const notice = await showcaseChannel
        .send({
          content:
            `💬 <@${message.author.id}>, I moved your reply into ` +
            `<#${sourceMessage.thread.id}> so **Ashen Members** stays clean.`,
          allowedMentions: {
            users: [message.author.id]
          }
        })
        .catch(() => null);

      if (notice) {
        setTimeout(() => {
          void notice.delete().catch(() => {});
        }, 8_000);
      }

      return true;
    }
  }

  // Every top-level showcase post gets one discussion thread.
  if (!message.hasThread) {
    const thread = await message
      .startThread({
        // Discord requires an initial name to create a discussion thread.
        // Staff can rename it manually; Vestra never changes it afterward.
        name: "Discussion",
        autoArchiveDuration: 1440,
        reason: "Keep Ashen Members showcase discussion organized"
      })
      .catch(error => {
        console.error(
          "❌ Could not create Ashen Members discussion thread:",
          error.message
        );
        return null;
      });

    if (thread) {
      await upsertAshenDiscussionDetails(message, thread).catch(error => {
        console.error("❌ Could not send Ashen post details:", error.message);
      });
      // Keep the original thread name. Discord generates a non-deletable
      // system message whenever a thread is renamed, so never automatically
      // rename live Ashen threads after creation. Existing custom names stay.
    }
  }

  return true;
}
