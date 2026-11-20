import { LANGUAGE_CHANNELS } from "../../guildConfig.js";
import { pool } from "../runtime/database.js";
import { LANGUAGE_KEYS } from "./languages.js";
import { client } from "../runtime/client.js";
import { PermissionFlagsBits } from "discord.js";

export async function savePrimaryLanguage(userId, languageKey) {
  if (!LANGUAGE_CHANNELS[languageKey]) return;
  await pool.query(
    `INSERT INTO user_preferences(user_id, primary_language, created_at, updated_at)
     VALUES($1, $2, NOW(), NOW())
     ON CONFLICT(user_id) DO UPDATE SET primary_language = EXCLUDED.primary_language, updated_at = NOW()`,
    [userId, languageKey]
  );
}

export async function inferPrimaryLanguage(member) {
  const saved = await pool.query(
    "SELECT primary_language FROM user_preferences WHERE user_id = $1",
    [member.id]
  );

  const savedLanguage = saved.rows[0]?.primary_language;
  if (savedLanguage && LANGUAGE_CHANNELS[savedLanguage]) return savedLanguage;

  const owned = LANGUAGE_KEYS.filter(key => member.roles.cache.has(LANGUAGE_CHANNELS[key].role));
  let chosen = owned.length === 1 ? owned[0] : owned.includes("english") ? "english" : owned[0] || "english";
  await savePrimaryLanguage(member.id, chosen);
  return chosen;
}

export async function loadPrimaryLanguageMap(userIds) {
  if (!userIds.length) return new Map();
  const result = await pool.query(
    "SELECT user_id, primary_language FROM user_preferences WHERE user_id = ANY($1::text[])",
    [userIds]
  );
  return new Map(result.rows.map(row => [row.user_id, row.primary_language]));
}

export function inferPrimaryFromRoles(member, savedMap) {
  const saved = savedMap.get(member.id);
  if (saved && LANGUAGE_CHANNELS[saved]) return saved;
  const owned = LANGUAGE_KEYS.filter(key => member.roles.cache.has(LANGUAGE_CHANNELS[key].role));
  if (owned.length === 1) return owned[0];
  if (owned.includes("english")) return "english";
  return owned[0] || "english";
}

export async function ensureLanguageAccess(member, languageKey) {
  const info = LANGUAGE_CHANNELS[languageKey];
  if (!info) return false;

  if (!member.roles.cache.has(info.role)) {
    try {
      await member.roles.add(info.role);
    } catch (error) {
      console.error(
        `⚠️ Could not add ${info.name} access to ${member.user.tag}:`,
        error.message
      );
    }
  }

  const channel = await client.channels.fetch(info.channel).catch(() => null);
  if (!channel?.isTextBased()) return false;

  return !!channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel);
}
