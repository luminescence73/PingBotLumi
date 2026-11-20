import { ChannelType, PermissionFlagsBits } from "discord.js";
import { getGuild } from "../guild/access.js";
import { dbGetState, dbSetState, pool } from "../runtime/database.js";
import { client } from "../runtime/client.js";

const KEYWORD_ALERT_OWNER_ID = "1291637835107012682";

const KEYWORD_ALERT_TERMS = ["black knights", "blacknights", "help", "kal", "krayt", "rex", "pia", "sus"];

const KEYWORD_ALERT_PATTERN = /(?<![a-z0-9])(?:black\s+knights|blacknights|help|kal|krayt|rex|pia|sus)(?![a-z0-9])/gi;

let keywordHistoryRunning = false;

let keywordHistoryFinished = false;

export function keywordAlertMatches(content) {
  const matches = [...String(content || "").matchAll(KEYWORD_ALERT_PATTERN)]
    .map(match => match[0].toLowerCase().replace(/\s+/g, " "));
  return [...new Set(matches)];
}

function keywordAlertAllowedChannel(channel, guild) {
  if (!channel || channel.guildId !== guild.id) return false;
  const supported = [ChannelType.GuildText, ChannelType.GuildAnnouncement,
    ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread];
  if (!supported.includes(channel.type)) return false;
  const me = guild.members.me;
  const permissions = me && channel.permissionsFor(me);
  return !!permissions?.has(PermissionFlagsBits.ViewChannel) &&
    !!permissions?.has(PermissionFlagsBits.ReadMessageHistory);
}

export async function sendKeywordAlert(message, historical = false) {
  if (!message?.author || message.author.bot || message.webhookId || !message.content) return false;
  const ashenGuild = getGuild();
  if (!ashenGuild || (message.guildId || message.guild?.id || message.channel?.guildId) !== ashenGuild.id) return false;
  const matches = keywordAlertMatches(message.content);
  if (!matches.length) return false;
  const reserved = await pool.query(
    "INSERT INTO keyword_alert_deliveries_v2(message_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING message_id",
    [message.id]
  );
  if (!reserved.rowCount) return false;
  try {
    const recipient = await client.users.fetch(KEYWORD_ALERT_OWNER_ID);
    const excerpt = message.content.length > 1100 ? message.content.slice(0, 1100) + "…" : message.content;
    await recipient.send({
      content: [
        historical ? "🔎 **Ashen keyword match · History**" : "🔎 **Ashen keyword match · New message**",
        "**Matched:** " + matches.join(", "),
        "**From:** " + message.author.username,
        "**Channel:** <#" + message.channel.id + ">",
        "**Message:** " + excerpt,
        "**Jump directly to message:** " + (message.url || "https://discord.com/channels/" + ashenGuild.id + "/" + message.channelId + "/" + message.id)
      ].join("\n"),
      allowedMentions: { parse: [] }
    });
    console.log("✅ Keyword DM sent:", historical ? "history" : "live", message.id, matches.join(", "));
    return true;
  } catch (error) {
    await pool.query("DELETE FROM keyword_alert_deliveries_v2 WHERE message_id = $1", [message.id]).catch(() => {});
    console.error("❌ Owner keyword DM failed:", error);
    return false;
  }
}

async function scanKeywordHistory() {
  if (keywordHistoryRunning || keywordHistoryFinished) return;
  keywordHistoryRunning = true;
  try {
    const guild = getGuild();
    if (!guild) return;
    await guild.channels.fetch();
    const channelMap = new Map();
    for (const channel of guild.channels.cache.values()) {
      if (keywordAlertAllowedChannel(channel, guild)) channelMap.set(channel.id, channel);
      if (!channel.threads || !keywordAlertAllowedChannel(channel, guild)) continue;
      try {
        const active = await channel.threads.fetchActive();
        for (const thread of active.threads.values()) {
          if (keywordAlertAllowedChannel(thread, guild)) channelMap.set(thread.id, thread);
        }
        for (const options of [{ type: "public" }, { type: "private" }]) {
          let before;
          for (let page = 0; page < 20; page++) {
            try {
              const result = await channel.threads.fetchArchived({ ...options, limit: 100, ...(before ? { before } : {}) });
              for (const thread of result.threads.values()) {
                if (keywordAlertAllowedChannel(thread, guild)) channelMap.set(thread.id, thread);
              }
              if (!result.hasMore || !result.threads.size) break;
              const last = [...result.threads.values()].at(-1);
              before = options.type === "public" ? last.archiveTimestamp : last.id;
              if (!before) break;
            } catch (error) {
              console.warn("⚠️ Keyword archived thread fetch skipped:", channel.id, options.type, error.message);
              break;
            }
          }
        }
      } catch (error) {
        console.warn("⚠️ Keyword thread discovery skipped:", channel.id, error.message);
      }
    }
    const channels = [...channelMap.values()];
    console.log(`🔎 Keyword history scan running across ${channels.length} accessible channels and threads.`);
    let sent = 0;
    let remaining = 0;
    let scanned = 0;
    let readable = 0;
    let matched = 0;
    let human = 0;
    // Continue scanning each channel until its oldest accessible message is reached.
    // Discord.js handles REST rate limits; pause briefly between pages to avoid bursts.
    for (const channel of channels) {
      const key = "keyword_history_v6_replay_" + channel.id;
      let state = await dbGetState(key) || {};
      if (state.done) continue;
      remaining++;
      let pages = 0;
      try {
      while (pages < 30) {
        const batch = await channel.messages.fetch({ limit: 100, ...(state.before ? { before: state.before } : {}) });
        if (!batch.size) {
          await dbSetState(key, { done: true });
          remaining--;
          break;
        }
        const messages = [...batch.values()].sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1);
        for (const message of messages) {
          scanned++;
          if (!message.author?.bot && !message.webhookId) {
            human++;
            if (message.content?.length) readable++;
            if (keywordAlertMatches(message.content).length) matched++;
          }
          if (await sendKeywordAlert(message, true)) sent++;
          state = { before: message.id };
          // Save progress periodically and after each page, not on every message.
          if (scanned % 100 === 0) await dbSetState(key, state);
        }
        await dbSetState(key, state);
        pages++;
        if (batch.size < 100) {
          await dbSetState(key, { done: true });
          remaining--;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 350));
      }
      } catch (error) {
        console.error("❌ Keyword channel scan failed:", channel.id, error.message);
      }
    }
    console.log(`🔎 Keyword history progress: ${scanned} checked, ${human} human, ${readable} readable, ${matched} keyword matches, ${sent} DMs sent, ${remaining} channels remaining.`);
    if (!remaining) {
      keywordHistoryFinished = true;
      console.log("✅ Ashen keyword history scan complete.");
    }
  } catch (error) {
    console.error("❌ Ashen keyword history scan:", error);
  } finally {
    keywordHistoryRunning = false;
  }
}

export function startKeywordHistoryScan() {
  setTimeout(() => {
    void (async () => {
      try {
        const owner = await client.users.fetch(KEYWORD_ALERT_OWNER_ID);
        await owner.send({ content: "🔎 **Vestra keyword monitor online**\nLive alerts are enabled. Replaying historical matches as individual clickable DMs across all accessible channels and threads. Keywords: " + KEYWORD_ALERT_TERMS.join(", "), allowedMentions: { parse: [] } });
        console.log("✅ Keyword monitor startup DM delivered.");
      } catch (error) {
        console.error("❌ Keyword monitor startup DM FAILED:", error);
      }
    })();
    // One-time replay of historical messages to recover individual keyword alerts.
    // A fresh checkpoint namespace is needed because the previous scan counted matches
    // but recorded no successfully delivered alerts.
    void scanKeywordHistory();
    setInterval(() => void scanKeywordHistory(), 30 * 1000);
  }, 90 * 1000);
}
