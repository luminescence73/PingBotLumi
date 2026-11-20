import { client } from "../runtime/client.js";
import { Events } from "discord.js";
import { ASHEN_WARRIORS, LANGUAGES } from "./access.js";
import { preferenceMessages, setupGuildMembersPanel } from "./panels.js";
import { pool } from "../runtime/database.js";
import { inferPrimaryLanguage, savePrimaryLanguage } from "./preferences.js";
import { LANGUAGE_CHANNELS } from "../../guildConfig.js";
import { LANGUAGE_KEYS } from "./languages.js";
import { PLAYSTYLE, REMINDERS, SOCIAL, TOURNAMENTS } from "../../roleConfig.js";
import { recordStaffPingAudit } from "../events/pingLog.js";

client.on(Events.GuildMemberAdd, async member => {
  if (member.user.bot) return;
  try {
    await member.roles.add(ASHEN_WARRIORS);
    console.log(`✅ Ashen Warriors added to ${member.user.tag}`);
    await setupGuildMembersPanel().catch(() => {});
  } catch (error) {
    console.error("❌ Could not add Ashen Warriors:", error.message);
  }
});

client.on(Events.GuildMemberRemove, async member => {
  if (member.user.bot) return;
  await setupGuildMembersPanel().catch(() => {});
});

function itemByEmoji(group, emoji) {
  return Object.values(group).find(x => x.emoji === emoji);
}

export async function reactionRole(reaction, user, adding) {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch();
  const message = reaction.message;
  if (!message.guild) return;
  const member = await message.guild.members.fetch(user.id);
  const emoji = reaction.emoji.name;

  if (message.id === preferenceMessages.languages?.id) {
    const item = itemByEmoji(LANGUAGES, emoji);
    if (!item) return;
    if (adding) {
      await member.roles.add(item.role);
      const existing = await pool.query("SELECT primary_language FROM user_preferences WHERE user_id = $1", [member.id]);
      if (!existing.rows[0]?.primary_language) {
        const key = Object.entries(LANGUAGES).find(([, value]) => value.role === item.role)?.[0];
        if (key) await savePrimaryLanguage(member.id, key);
      }
    } else {
      await member.roles.remove(item.role);
      const current = await inferPrimaryLanguage(member);
      if (LANGUAGE_CHANNELS[current].role === item.role) {
        const fallback = LANGUAGE_KEYS.find(key => key !== current && member.roles.cache.has(LANGUAGE_CHANNELS[key].role));
        if (fallback) await savePrimaryLanguage(member.id, fallback);
      }
    }
    return;
  }

  if (message.id === preferenceMessages.reminders?.id) {
    const item = itemByEmoji(REMINDERS, emoji);
    if (!item) return;
    if (adding) await member.roles.add(item.role); else await member.roles.remove(item.role);
    return;
  }

  if (message.id === preferenceMessages.tournaments?.id) {
    const item = itemByEmoji(TOURNAMENTS, emoji);
    if (!item) return;
    if (adding) await member.roles.add(item.role); else await member.roles.remove(item.role);
    return;
  }

  if (message.id === preferenceMessages.playstyle?.id) {
    const item = itemByEmoji(PLAYSTYLE, emoji);
    if (!item) return;
    if (adding) {
      for (const other of Object.values(PLAYSTYLE)) {
        if (other.role !== item.role && member.roles.cache.has(other.role)) await member.roles.remove(other.role);
      }
      await member.roles.add(item.role);
    } else await member.roles.remove(item.role);
    return;
  }

  if (message.id === preferenceMessages.social?.id) {
    const item = itemByEmoji(SOCIAL, emoji);
    if (!item) return;
    if (adding) {
      for (const other of Object.values(SOCIAL)) {
        if (other.role !== item.role && member.roles.cache.has(other.role)) await member.roles.remove(other.role);
      }
      await member.roles.add(item.role);
    } else await member.roles.remove(item.role);
  }
}

// Staff-only audit of event role subscriptions from onboarding, settings and staff.
client.on(Events.GuildMemberUpdate, (previous, current) => {
  if (!current?.guild || current.user?.bot) return;
  const monitored = [...Object.values(REMINDERS), ...Object.values(TOURNAMENTS)];
  const added = [], removed = [];
  for (const item of monitored) {
    const before = previous.roles.cache.has(item.role);
    const after = current.roles.cache.has(item.role);
    if (before === after) continue;
    (after ? added : removed).push(item.name);
  }
  if (!added.length && !removed.length) return;
  const lines = [
    "Member: <@" + current.id + ">",
    added.length ? "Enabled: " + added.join(", ") : "",
    removed.length ? "Disabled: " + removed.join(", ") : ""
  ].filter(Boolean);
  void recordStaffPingAudit({
    kind:"subscription", title:"Guild ping preferences changed",
    detail:lines.join("\n")
  }).catch(error => console.error("Staff subscription audit:", error));
});
