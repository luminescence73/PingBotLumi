import { pool } from "../runtime/database.js";
import { LANGUAGE_KEYS } from "../guild/languages.js";
import { LANGUAGE_CHANNELS } from "../../guildConfig.js";
import { client } from "../runtime/client.js";
import { PermissionFlagsBits } from "discord.js";
import { getGuild } from "../guild/access.js";
import { recordStaffPingAudit, sendMasterLog } from "./pingLog.js";
import {
  ensureLanguageAccess,
  inferPrimaryFromRoles,
  loadPrimaryLanguageMap
} from "../guild/preferences.js";
import { googleTranslate } from "../translation/google.js";

// A Discord role mention alerts EVERY member holding that role who can
// see the channel. Using the original subscription role in six channels
// would therefore ping multilingual members multiple times. Maintain a
// separate, non-hoisted role for each event + preferred-language cohort.
async function getScopedPingRoles(guild, subscriptionRole, activeLanguages) {
  const rows = await pool.query(
    "SELECT language_key, scoped_role_id FROM localized_ping_roles WHERE source_role_id = $1",
    [subscriptionRole.id]
  );
  const known = new Map(rows.rows.map(row => [row.language_key, row.scoped_role_id]));
  const roles = new Map();

  for (const key of LANGUAGE_KEYS) {
    const existingId = known.get(key);
    if (!existingId && !activeLanguages.has(key)) continue;

    let helperRole = existingId
      ? await guild.roles.fetch(existingId).catch(() => null)
      : null;

    if (!helperRole && activeLanguages.has(key)) {
      const info = LANGUAGE_CHANNELS[key];
      helperRole = await guild.roles.create({
        name: `${subscriptionRole.name.slice(0, 70)} · ${info.name}`,
        hoist: false,
        mentionable: false,
        reason: "Notify subscribers once in their primary language"
      });
      await pool.query(
        `INSERT INTO localized_ping_roles(source_role_id, language_key, scoped_role_id)
         VALUES($1, $2, $3)
         ON CONFLICT (source_role_id, language_key)
         DO UPDATE SET scoped_role_id = EXCLUDED.scoped_role_id`,
        [subscriptionRole.id, key, helperRole.id]
      );
    }
    if (helperRole) roles.set(key, helperRole);
  }
  return roles;
}

async function syncScopedPingRoles(guild, scopedRoles, recipientsByLanguage) {
  // Reconcile EVERY previously-created cohort for this event, including
  // empty cohorts. Finish all removals before sending a single role ping.
  for (const [key, scopedRole] of scopedRoles) {
    const expected = new Set((recipientsByLanguage.get(key) || []).map(m => m.id));
    for (const member of [...scopedRole.members.values()]) {
      if (!expected.has(member.id)) {
        await member.roles.remove(scopedRole, "No longer subscribed to this event in this language");
      }
    }
    for (const id of expected) {
      const member = guild.members.cache.get(id);
      if (!member) throw new Error("Cannot resolve localized notification subscriber " + id);
      if (!member.roles.cache.has(scopedRole.id)) {
        await member.roles.add(scopedRole, "Event alerts in preferred language");
      }
    }
  }
}

async function sendScopedRolePing(channel, helperRole, text) {
  const canMentionAllRoles =
    !!channel.permissionsFor(client.user)?.has(PermissionFlagsBits.MentionEveryone);
  let temporarilyMentionable = false;

  if (!helperRole.mentionable && !canMentionAllRoles) {
    // A bot without Mention All Roles may temporarily enable this specific
    // helper role; restore it immediately after the message is sent.
    await helperRole.setMentionable(true, "Send primary-language guild notification");
    temporarilyMentionable = true;
  }

  try {
    await channel.send({
      content: `<@&${helperRole.id}>\n${text}`,
      allowedMentions: {
        parse: [],
        roles: [helperRole.id],
        users: [],
        repliedUser: false
      }
    });
  } finally {
    if (temporarilyMentionable) {
      await helperRole.setMentionable(false, "Restore private notification helper role")
        .catch(error => console.error("Could not restore scoped role mentionability:", error));
    }
  }
}

export async function sendLocalizedRoleNotification(roleId, englishText, label, options = {}) {
  const guild = getGuild();
  if (!guild) return 0;
  await guild.members.fetch();

  const subscriptionRole = await guild.roles.fetch(roleId).catch(() => null);
  if (!subscriptionRole) {
    console.error("Notification role missing: " + roleId);
    await sendMasterLog(roleId, label, englishText, 0).catch(console.error);
    await recordStaffPingAudit({kind:"failure",title:label,detail:"Subscription role missing: "+roleId,failed:1}).catch(console.error);
    return 0;
  }

  const subscribers = subscriptionRole.members.filter(m => !m.user.bot);
  const prefs = await loadPrimaryLanguageMap([...subscribers.keys()]);
  const byLanguage = new Map(LANGUAGE_KEYS.map(key => [key, []]));
  for (const member of subscribers.values()) {
    const key = inferPrimaryFromRoles(member, prefs);
    byLanguage.get(key)?.push(member);
  }

  const deliveries = [];
  const unreachable = [], translationFallbacks = [], successfulLanguages = [];
  let failed = 0;
  const reachableByLanguage = new Map();
  for (const [key, recipients] of byLanguage) {
    if (!recipients.length) continue;

    const info = LANGUAGE_CHANNELS[key];
    const channel = await client.channels.fetch(info.channel).catch(() => null);
    if (!channel?.isTextBased()) {
      console.error("Missing " + info.name + " General channel for " + label);
      failed += recipients.length;
      unreachable.push(info.name+" General missing ("+recipients.length+" subscribers)");
      continue;
    }

    const reachable = [];
    for (const member of recipients) {
      if (await ensureLanguageAccess(member, key)) reachable.push(member);
      else {
        failed++;
        unreachable.push(info.name+" channel access unavailable for "+member.id);
        console.warn(label + ": " + member.id + " cannot view " + info.name + " General");
      }
    }
    if (!reachable.length) continue;

    reachableByLanguage.set(key, reachable);
    deliveries.push({ key, info, channel, reachable });
  }

  // Fail closed: if any role membership cannot be reconciled, send the
  // translated announcement without mentions rather than risk double pings.
  let scopedRoles = new Map();
  let rolesReady = true;
  try {
    scopedRoles = await getScopedPingRoles(
      guild, subscriptionRole, new Set(reachableByLanguage.keys())
    );
    await syncScopedPingRoles(guild, scopedRoles, reachableByLanguage);
    for (const key of reachableByLanguage.keys()) {
      if (!scopedRoles.has(key)) throw new Error("Missing locale role for " + key);
    }
  } catch (error) {
    rolesReady = false;
    unreachable.push("Scoped role sync failed: "+error.message);
    console.error("Failed to synchronize preferred-language notification roles:", error);
  }

  let delivered = 0;
  for (const {key, info, channel, reachable} of deliveries) {
    let localized = englishText;
    if (key !== "english") {
      try {
        localized = await googleTranslate(englishText, info.code, "en");
      } catch (error) {
        translationFallbacks.push(info.name);
        console.error("Notification translation fallback (" + key + "):", error.message);
      }
    }

    try {
      if (rolesReady) {
        await sendScopedRolePing(channel, scopedRoles.get(key), localized);
        delivered += reachable.length;
        successfulLanguages.push(info.name);
      } else {
        await channel.send({
          content: localized,
          allowedMentions: { parse: [], users: [], roles: [] }
        });
        failed += reachable.length;
        unreachable.push(info.name+" posted without alerts (scoped roles unavailable)");
      }
    } catch (error) {
      failed += reachable.length;
      unreachable.push(info.name+" delivery failed: "+error.message);
      console.error("Role ping failed (" + label + " / " + key + "):", error);
      // A role permission error must not accidentally ping the global
      // subscription role or expose a long list of member mentions.
    }
  }

  console.log(
    `${label}: ${subscribers.size} subscribers, ${delivered} localized role notifications.`
  );
  // The archive does not ping and should not cause a scheduled event to
  // retry (and double notify) when the log channel is unavailable.
  await sendMasterLog(roleId, label, englishText, delivered)
    .catch(error => console.error("Notification archive failed:", error));
  await recordStaffPingAudit({
    kind:"delivery", title:label, actorId:options.actorId || null,
    detail: [
      "Subscriptions: "+subscribers.size,
      unreachable.length ? "Issues: "+unreachable.join("; ").slice(0,1000) : "No delivery issues detected.",
      translationFallbacks.length ? "Translation fallback to English: "+translationFallbacks.join(", ") : ""
    ].filter(Boolean).join("\n"),
    delivered, failed:failed+translationFallbacks.length, languages:successfulLanguages
  }).catch(error => console.error("Staff ping audit failed:", error));
  if (options.actorId) {
    await recordStaffPingAudit({kind:"manual",title:label,
      detail:"Authorized staff manually initiated this notification.",
      actorId:options.actorId,delivered}).catch(console.error);
  }
  return delivered;
}
