import { client } from "../runtime/client.js";
import { getMemberGuildPingsChannel } from "../guild/sidebar.js";
import { dbGetState, dbSetState, pool, wasEventSent } from "../runtime/database.js";
import { ONBOARDING_COMPLETE, getGuild, isStaff } from "../guild/access.js";
import { CHANNELS } from "../../guildConfig.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits
} from "discord.js";
import { SCHEDULED_EVENTS, chicagoParts, dateKey, eventApplies, eventDayLabel, eventTimeForDate, format12Hour, upcomingEvents } from "./schedule.js";
import { upsertBotPanel } from "../guild/panels.js";

const GUILD_PING_DIVIDER = "━━━━━━━━━━━━━━━━━━━━";

function isGuildPingAlertRecord(content) {
  const value = String(content || "");
  const header = /^<@&\d+>\s+\*\*/.test(value);
  const spaced = value.startsWith(GUILD_PING_DIVIDER + "\n");
  const hasDelivery = value.includes("🌎 Vestra delivered ") ||
    value.includes("🌎 Localized delivery count was not recorded.");
  return (header || spaced) && hasDelivery;
}

function formatGuildPingSpacing(content) {
  const raw = String(content || "");
  if (!isGuildPingAlertRecord(raw) || raw.startsWith(GUILD_PING_DIVIDER + "\n")) return null;
  const lines = raw.split("\n");
  const heading = lines.shift() || "";
  const details = lines.join("\n").trim();
  return [
    GUILD_PING_DIVIDER,
    "",
    "🔔 " + heading,
    "",
    details
  ].join("\n");
}

function formatAlertHistoryMessage(roleId, label, text, deliveredCount) {
  const displayedRole = roleId ? `<@&${roleId}>` : "";
  const original = [
    [displayedRole, `**${label}**`].filter(Boolean).join(" "),
    text || "Event notification sent.",
    "",
    Number.isInteger(deliveredCount)
      ? `🌎 Vestra delivered ${deliveredCount} localized notifications.`
      : "🌎 Localized delivery count was not recorded."
  ].join("\n");
  return formatGuildPingSpacing(original) ||
    [GUILD_PING_DIVIDER, "", "🔔 **" + label + "**", displayedRole, "",
      text || "Event notification sent.", "",
      Number.isInteger(deliveredCount)
        ? `🌎 Vestra delivered ${deliveredCount} localized notifications.`
        : "🌎 Localized delivery count was not recorded."].join("\n");
}

async function mirrorStaffGuildPingRecord(sourceMessage) {
  if (!sourceMessage?.id || sourceMessage.author?.id !== client.user.id) return false;
  // The member archive only receives recognizable event announcements.
  if (!isGuildPingAlertRecord(sourceMessage.content)) return false;
  const memberChannel = await getMemberGuildPingsChannel();
  if (!memberChannel) {
    console.warn("⚠️ Member guild-pings channel not found; staff alert record preserved.");
    return false;
  }

  // Claim the source message ID in Postgres before delivery. This prevents
  // repeated startup/history sync from duplicating public messages.
  const claim = await pool.query(
    `INSERT INTO guild_ping_member_mirrors(source_message_id, member_channel_id)
     VALUES($1, $2) ON CONFLICT(source_message_id) DO NOTHING
     RETURNING source_message_id`,
    [sourceMessage.id, memberChannel.id]
  );
  if (!claim.rowCount) return false;

  try {
    const mirrored = await memberChannel.send({
      content: sourceMessage.content,
      allowedMentions: { parse: [], roles: [], users: [], repliedUser: false }
    });
    await pool.query(
      `UPDATE guild_ping_member_mirrors SET mirrored_message_id = $2
       WHERE source_message_id = $1`,
      [sourceMessage.id, mirrored.id]
    );
    return true;
  } catch (error) {
    // Do not retry an ambiguous Discord send, which could double-post.
    console.error("❌ Could not mirror guild ping record:", error);
    return false;
  }
}

const STAFF_PING_DASHBOARD_TAG = "# VESTRA / STAFF PING CONTROL";

async function getPrivateStaffPingChannel() {
  const guild = getGuild();
  const channel = await client.channels.fetch(CHANNELS.REMINDERS).catch(() => null);
  if (!guild || !channel?.isTextBased?.()) return null;
  const publicChannel = await getMemberGuildPingsChannel().catch(() => null);
  if (channel.id === publicChannel?.id) {
    console.error("Staff ping monitor: member channel collision. Private monitoring disabled.");
    return null;
  }
  const everyone = channel.permissionsFor(guild.roles.everyone);
  const onboardedRole = guild.roles.cache.get(ONBOARDING_COMPLETE);
  const onboarded = onboardedRole && channel.permissionsFor(onboardedRole);
  if (!everyone || !onboarded ||
      everyone.has(PermissionFlagsBits.ViewChannel) || onboarded.has(PermissionFlagsBits.ViewChannel)) {
    console.error("Staff ping monitor: guild ping log privacy could not be verified. Monitoring disabled.");
    return null;
  }
  return channel;
}

export async function recordStaffPingAudit({
  kind, title, detail = "", eventKey = null, actorId = null,
  delivered = 0, failed = 0, languages = []
}) {
  const result = await pool.query(
    "INSERT INTO guild_ping_staff_audit " +
    "(kind,title,detail,event_key,actor_id,delivered_count,failed_count,languages) " +
    "VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) " +
    "ON CONFLICT DO NOTHING RETURNING id",
    [kind,title,detail,eventKey,actorId,delivered,failed,JSON.stringify(languages)]
  );
  if (!result.rowCount) return false;

  // Keep routine success/manual activity in the audit database and dashboard.
  // Only actionable problems should post into the private staff channel.
  const actionable = kind === "failure" || kind === "missed" ||
    kind === "duplicate" || (kind === "delivery" && failed > 0);
  if (!actionable) return true;
  const channel = await getPrivateStaffPingChannel();
  if (channel) {
    const lines = [
      "⚠️ **GUILD PING ISSUE**",
      "**" + title + "**",
      detail,
      failed ? "**Failures:** " + failed : ""
    ].filter(Boolean);
    await channel.send({
      content: lines.join("\n").slice(0,1900),
      allowedMentions: { parse: [], roles: [], users: [], repliedUser: false }
    }).catch(error => console.error("Staff ping audit delivery:", error.message));
  }
  return true;
}

async function staffPingDailyNumbers(day) {
  const result = await pool.query(
    "SELECT COUNT(*) FILTER (WHERE kind='delivery')::int AS sent, " +
    "COALESCE(SUM(delivered_count) FILTER (WHERE kind='delivery'),0)::int AS delivered, " +
    "(COALESCE(SUM(failed_count) FILTER (WHERE kind='delivery'),0) + " +
    "COUNT(*) FILTER (WHERE kind='failure'))::int AS failed, " +
    "COUNT(*) FILTER (WHERE kind='duplicate')::int AS duplicates, " +
    "COUNT(*) FILTER (WHERE kind='missed')::int AS missed, " +
    "COUNT(*) FILTER (WHERE kind='subscription')::int AS subscriptions " +
    "FROM guild_ping_staff_audit " +
    "WHERE (recorded_at AT TIME ZONE 'America/Chicago')::date = $1::date",
    [day]
  );
  return result.rows[0];
}

let staffDashboardUpdating = false;

export async function updateStaffPingDashboard() {
  if (staffDashboardUpdating) return;
  staffDashboardUpdating = true;
  try {
    const channel = await getPrivateStaffPingChannel();
    if (!channel) return;
    const today = dateKey(chicagoParts());
    const stats = await staffPingDailyNumbers(today);
    const latest = await pool.query(
      "SELECT kind,title,recorded_at FROM guild_ping_staff_audit ORDER BY id DESC LIMIT 3"
    );
    const next = upcomingEvents(3).map(event =>
      "• " + eventDayLabel(event) + " " + format12Hour(event.hour,event.minute) +
      " — " + event.label
    ).join("\n") || "No scheduled alerts.";
    const recent = latest.rows.map(row =>
      "• " + row.kind + ": " + row.title +
      " · <t:" + Math.floor(new Date(row.recorded_at).getTime()/1000) + ":t>"
    ).join("\n") || "No activity recorded yet.";
    const content = [
      STAFF_PING_DASHBOARD_TAG,
      "",
      "**STAFF ONLY — this panel and its diagnostics are never copied to member Guild Pings.**",
      "",
      "**TODAY · " + today + " (Central)**",
      "✅ Event announcements: **" + stats.sent + "**",
      "🌐 Members notified: **" + stats.delivered + "**",
      "⚠️ Delivery / translation issues: **" + stats.failed + "**",
      "🛡️ Duplicate requests blocked: **" + stats.duplicates + "**",
      "🚨 Missed scheduled alerts: **" + stats.missed + "**",
      "🔔 Subscription changes: **" + stats.subscriptions + "**",
      "",
      "**NEXT SCHEDULED**",
      next,
      "",
      "**RECENT STAFF ACTIVITY**",
      recent,
      "",
      "Uncertain/failed sends are never automatically retried (prevents duplicate pings)."
    ].join("\n");
    const panel = await upsertBotPanel(
      channel, "panel_staff_ping_monitor",
      {
        content, embeds: [],
        allowedMentions: { parse: [], users: [], roles: [] },
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("staff_ping_refresh")
            .setLabel("Refresh Staff Monitor").setStyle(ButtonStyle.Secondary)
        )]
      },
      STAFF_PING_DASHBOARD_TAG
    );
    if (panel && !panel.pinned) {
      await panel.pin().catch(error => console.warn("Staff monitor pin:", error.message));
    }
  } finally {
    staffDashboardUpdating = false;
  }
}

let staffAuditSweepRunning = false;

export async function auditMissedScheduledPings() {
  if (staffAuditSweepRunning) return;
  staffAuditSweepRunning = true;
  try {
    const now = chicagoParts(), today = dateKey(now);
    const nowMinutes = now.hour*60 + now.minute;
    for (const event of SCHEDULED_EVENTS) {
      if (!eventApplies(event,now.year,now.month,now.day,now.weekday)) continue;
      const [hour,minute] = eventTimeForDate(event,now.year,now.month,now.day);
      if (nowMinutes <= hour*60+minute+3) continue;
      const eventKey = today + ":" + event.key;
      if (await wasEventSent(eventKey)) continue;
      await recordStaffPingAudit({
        kind: "missed", title: event.label, eventKey,
        detail: "Scheduled " + format12Hour(hour,minute) +
          " Central; no successful schedule record. Review before any manual retry."
      });
    }
  } finally {
    staffAuditSweepRunning = false;
  }
}

let staffSummaryRunning = false;

export async function maybeSendStaffDailyPingSummary() {
  if (staffSummaryRunning) return;
  staffSummaryRunning = true;
  try {
    const now = chicagoParts();
    if (now.hour === 0 && now.minute < 5) return;
    const d = new Date(Date.UTC(now.year,now.month-1,now.day-1,12));
    const yesterday = d.getUTCFullYear() + "-" +
      String(d.getUTCMonth()+1).padStart(2,"0") + "-" +
      String(d.getUTCDate()).padStart(2,"0");
    const stats = await staffPingDailyNumbers(yesterday);
    await recordStaffPingAudit({
      kind:"daily", title:yesterday+" Guild Ping Summary",
      eventKey:yesterday+":daily_summary",
      detail:"Events: "+stats.sent+" · Members notified: "+stats.delivered+
        " · Failures: "+stats.failed+" · Duplicates stopped: "+stats.duplicates+
        " · Missed schedules: "+stats.missed+" · Subscription changes: "+stats.subscriptions
    });
  } finally {
    staffSummaryRunning = false;
  }
}

// One-time cleanup of the old verbose Night Conquest staff entry.
// Edit only Vestra's own matching message; do not repost or touch member logs.
export async function cleanOldNightConquestStaffEntry() {
  const stateKey = "cleanup_night_conquest_second_run_staff_2026_11_10_v2";
  if ((await dbGetState(stateKey))?.completed) return;
  const channel = await getPrivateStaffPingChannel();
  if (!channel) return;
  let before;
  let edited = 0;
  let scanned = 0;
  for (let page = 0; page < 10; page++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    for (const msg of batch.values()) {
      scanned++;
      if (msg.author?.id !== client.user.id) continue;
      const content = msg.content || "";
      if (!/Night Conquest\s*[—–-]\s*Second Run/i.test(content)) continue;
      // Target only the verbose staff records, not short unrelated messages.
      if (!/STAFF PING AUDIT|Subscriptions:\s*15|Vestra delivered 15 localized/i.test(content)) continue;
      await msg.edit({
        content: "🔔 **Night Conquest — Second Run**\nSecond run notification sent.",
        allowedMentions: { parse: [] }
      });
      edited++;
    }
    before = batch.last()?.id;
  }
  if (edited) {
    await dbSetState(stateKey, { completed: true, edited });
    console.log(`✅ Cleaned ${edited} old Night Conquest staff message(s), scanned ${scanned}.`);
  } else {
    console.warn(`⚠️ Night Conquest cleanup: no matching staff message in ${scanned} scanned messages.`);
  }
}

export async function sendMasterLog(roleId, label, text, deliveredCount) {
  // Archive successful event announcements once, in the member history only.
  // Do not duplicate the entire announcement in the private staff log.
  const channel = await getMemberGuildPingsChannel();
  if (!channel?.isTextBased()) {
    console.warn("⚠️ Member guild-pings archive unavailable:", label);
    return;
  }
  await channel.send({
    content: formatAlertHistoryMessage(roleId, label, text, deliveredCount),
    allowedMentions: { parse: [], roles: [], users: [], repliedUser: false }
  });
}

// Bring over recent existing event records once, with no mentions.
// Only copy Vestra-authored role-alert records, never staff-only notes/panels.
export async function backfillRecentGuildPingRecords() {
  const staffLog = await client.channels.fetch(CHANNELS.REMINDERS).catch(() => null);
  if (!staffLog?.isTextBased()) return;
  if (!await getMemberGuildPingsChannel()) return;

  const recent = await staffLog.messages.fetch({ limit: 50 });
  const records = [...recent.values()]
    .filter(message =>
      message.author?.id === client.user.id &&
      isGuildPingAlertRecord(message.content)
    )
    .reverse();

  let mirrored = 0;
  for (const message of records) {
    if (await mirrorStaffGuildPingRecord(message)) mirrored++;
  }
  console.log("✅ Recent guild ping records synced to members:", mirrored);
}

// Format recent existing staff and member alert records without reposting
// or changing timestamps. One-time only; never touch member/staff-authored posts.
export async function spaceExistingGuildPingRecords() {
  const key = "guild_ping_spacing_2026_11_09_v1";
  if ((await dbGetState(key))?.completed) return;
  const channels = [
    await client.channels.fetch(CHANNELS.REMINDERS).catch(() => null),
    await getMemberGuildPingsChannel()
  ].filter(Boolean);

  let scanned = 0, edited = 0, errors = 0;
  for (const channel of channels) {
    let before = null;
    for (let pageNo = 0; pageNo < 5; pageNo++) {
      const batch = await channel.messages.fetch({
        limit: 100,
        ...(before ? { before } : {})
      });
      if (!batch.size) break;

      for (const message of batch.values()) {
        scanned++;
        if (message.author?.id !== client.user.id) continue;
        const next = formatGuildPingSpacing(message.content);
        if (!next) continue;
        try {
          await message.edit({
            content: next,
            allowedMentions: { parse: [], roles: [], users: [] }
          });
          edited++;
        } catch (error) {
          errors++;
          console.error("❌ Could not separate guild ping record " + message.id + ":", error.message);
        }
      }
      before = batch.last()?.id;
      if (batch.size < 100 || !before) break;
    }
  }
  if (!errors) {
    await dbSetState(key, { completed: true, edited, scanned });
  }
  console.log("✅ Guild pings visually separated:", edited, "updated,", scanned, "checked,", errors, "errors");
}

// Convert Vestra's old boxed event-log embeds into the same compact
// text format without deleting/reposting messages or changing timestamps.
export async function migrateLegacyAlertHistory() {
  const completionKey = "alert_history_plaintext_migration_v2";
  if ((await dbGetState(completionKey))?.completed) return;

  const channel = await client.channels.fetch(CHANNELS.REMINDERS).catch(() => null);
  if (!channel?.isTextBased() || !channel.messages?.fetch) {
    console.warn("⚠️ Guild ping log cleanup postponed: channel unavailable.");
    return;
  }

  let before;
  let inspected = 0;
  let converted = 0;
  let failed = 0;

  while (true) {
    const page = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    });

    if (!page.size) break;

    for (const message of page.values()) {
      inspected++;
      if (message.author.id !== client.user.id) continue;

      // Leave the important #guild-ping-log information panel alone.
      if (message.content?.includes("# 🔔 Ashen Guild Ping Log")) continue;

      const embed = message.embeds?.find(e => {
        const fieldNames = (e.fields || []).map(f => f.name || "");
        return (
          e.title?.startsWith("🔔 ") ||
          fieldNames.some(name => /localized delivery/i.test(name)) ||
          fieldNames.some(name => /subscriber role/i.test(name))
        );
      });
      if (!embed) continue;

      const roleField = (embed.fields || []).find(field => /subscriber role/i.test(field.name || ""));
      const deliveryField = (embed.fields || []).find(field => /localized delivery/i.test(field.name || ""));
      const roleId =
        roleField?.value?.match(/<@&(\d+)>/)?.[1] ||
        embed.description?.match(/<@&(\d+)>/)?.[1] ||
        null;
      const reportedCount =
        deliveryField?.value?.match(/(\d+)\s+members?\s+notified/i) ||
        embed.description?.match(/(\d+)\s+members?\s+notified/i);
      const count = reportedCount ? Number(reportedCount[1]) : null;
      const rawTitle = (embed.title || "Guild Alert").replace(/^🔔\s*/, "").trim();
      const label = rawTitle || "Guild Alert";
      const content = formatAlertHistoryMessage(
        roleId,
        label,
        embed.description || "Event notification sent.",
        count
      );

      try {
        await message.edit({
          content,
          embeds: [],
          allowedMentions: { parse: [] }
        });
        converted++;
      } catch (error) {
        failed++;
        console.error(`❌ Could not convert guild-ping-log message ${message.id}:`, error.message);
      }
    }

    before = page.last()?.id;
    if (!before) throw new Error("Alert-history pagination stopped unexpectedly.");
    if (page.size < 100) break;
  }

  // A failed edit may be retried at the next restart; already-converted
  // messages have no embedded alert to convert a second time.
  if (failed === 0) {
    await dbSetState(completionKey, { completed: true, inspected, converted });
  }
  console.log(`✅ Guild ping log cleanup: ${converted} converted, ${failed} failed, ${inspected} scanned.`);
}

export async function staffPingRefresh(interaction) {
  const member = interaction.guild ? await interaction.guild.members.fetch(interaction.user.id) : null;
  if (!isStaff(member)) return interaction.reply({ content:"Staff-only control.", flags:MessageFlags.Ephemeral });
  if (interaction.channelId !== CHANNELS.REMINDERS || !await getPrivateStaffPingChannel()) {
    return interaction.reply({ content:"Staff monitor channel privacy cannot be verified.", flags:MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags:MessageFlags.Ephemeral });
  await updateStaffPingDashboard();
  return interaction.editReply("✅ Staff monitor refreshed. Member Guild Pings were not changed.");
}
