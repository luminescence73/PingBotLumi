import { getGuild } from "../guild/access.js";
import { ChannelType } from "discord.js";
import { LANGUAGE_CHANNELS } from "../../guildConfig.js";
import { pool } from "../runtime/database.js";
import { LANGUAGE_KEYS } from "../guild/languages.js";

const translationHealthAlerts = new Map();

let translationHealthRunning = false;

async function notifyTranslationHealth(languageKey, status, detail) {
  const guild = getGuild();
  const channel = guild?.channels?.cache?.find(
    ch => ch.type === ChannelType.GuildText && ch.name === "bot-logs"
  );
  if (!channel) {
    console.warn("Translation health alert (bot-logs unavailable):", languageKey, status, detail);
    return;
  }
  const info = LANGUAGE_CHANNELS[languageKey];
  await channel.send({
    content: `🌐 **VESTRA TRANSLATION HEALTH · ${status}**\n${info.emoji} **${info.name}** — <#${info.channel}>\n${detail}`,
    allowedMentions: { parse: [] }
  });
}

async function checkTranslationHealth() {
  if (translationHealthRunning) return;
  translationHealthRunning = true;
  try {
    // Only examine source messages at least 3 minutes old to allow queued work.
    // Limit the window to 30 minutes so old incidents do not create new alerts.
    const result = await pool.query(`
      SELECT tg.group_id, tg.source_language,
             ARRAY_AGG(tm.language_key) FILTER (WHERE tm.is_source = FALSE) AS delivered
      FROM translation_groups tg
      LEFT JOIN translation_messages tm ON tm.group_id = tg.group_id
      WHERE tg.created_at >= NOW() - INTERVAL '30 minutes'
        AND tg.created_at < NOW() - INTERVAL '3 minutes'
      GROUP BY tg.group_id, tg.source_language
      ORDER BY tg.group_id DESC
      LIMIT 150
    `);
    const missing = new Map(LANGUAGE_KEYS.map(key => [key, 0]));
    for (const row of result.rows) {
      const delivered = new Set(row.delivered || []);
      for (const key of LANGUAGE_KEYS) {
        if (key !== row.source_language && !delivered.has(key)) {
          missing.set(key, missing.get(key) + 1);
        }
      }
    }
    for (const key of LANGUAGE_KEYS) {
      const count = missing.get(key);
      const previous = translationHealthAlerts.get(key);
      if (count > 0) {
        if (!previous || Date.now() - previous.lastAlert > 60 * 60 * 1000) {
          await notifyTranslationHealth(
            key, "DELIVERY WARNING",
            `Missing ${count} translated message mapping(s) from recent source activity. Check Railway logs and channel/webhook permissions. This does not necessarily mean the channel is fully offline.`
          );
          translationHealthAlerts.set(key, { lastAlert: Date.now(), active: true });
        }
      } else if (previous?.active) {
        await notifyTranslationHealth(
          key, "RECOVERED",
          "No missing translation mappings detected in the current monitoring window."
        );
        translationHealthAlerts.set(key, { lastAlert: Date.now(), active: false });
      }
    }
  } catch (error) {
    console.error("❌ Translation health monitor:", error);
  } finally {
    translationHealthRunning = false;
  }
}

export function startTranslationHealthMonitor() {
  // Delay initial audit until startup work settles.
  setTimeout(() => {
    void checkTranslationHealth();
    setInterval(() => void checkTranslationHealth(), 5 * 60 * 1000);
  }, 60 * 1000);
}
