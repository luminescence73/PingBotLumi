import { isStaff } from "../guild/access.js";
import { ActionRowBuilder, MessageFlags, StringSelectMenuBuilder } from "discord.js";
import { SCHEDULED_EVENTS, chicagoParts, dateKey, eventTimeForDate } from "./schedule.js";
import { pool } from "../runtime/database.js";
import { recordStaffPingAudit } from "./pingLog.js";
import { sendLocalizedRoleNotification } from "./notifications.js";
import { REMINDERS } from "../../roleConfig.js";

export async function conquestSecondRun(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!isStaff(member)) {
    return interaction.reply({
      content: "Only Ashen staff can send a second-run Conquest alert.",
      flags: MessageFlags.Ephemeral
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("conquest_second_run_select")
    .setPlaceholder("Choose which Conquest second run is starting")
    .addOptions([
      { label: "Morning Conquest — Run 2", value: "morning", emoji: "🌅" },
      { label: "Night Conquest — Run 2", value: "night", emoji: "🌌" }
    ]);
  return interaction.reply({
    content: "Select the Conquest run to notify. Each second-run alert can be sent only once per day.",
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral
  });
}

export async function conquestSecondRunSelect(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!isStaff(member)) {
    return interaction.reply({
      content: "Only Ashen staff can send a second-run Conquest alert.",
      flags: MessageFlags.Ephemeral
    });
  }

  const selected = interaction.values[0];
  if (selected !== "morning" && selected !== "night") {
    return interaction.reply({
      content: "Invalid Conquest selection.",
      flags: MessageFlags.Ephemeral
    });
  }

  const event = SCHEDULED_EVENTS.find(item => item.key === selected);
  const now = chicagoParts();
  const [firstHour, firstMinute] = eventTimeForDate(
    event, now.year, now.month, now.day
  );
  if (now.hour * 60 + now.minute < firstHour * 60 + firstMinute) {
    return interaction.reply({
      content: "The scheduled first-run Conquest alert has not started yet.",
      flags: MessageFlags.Ephemeral
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Atomic claim avoids multiple staff clicks issuing duplicate run-2 pings.
  // Claim before sending; don't auto-retry a possibly partial delivery.
  const claimKey = dateKey(now) + ":conquest_second_run:" + selected;
  const claimed = await pool.query(
    "INSERT INTO sent_events(event_key) VALUES($1) " +
    "ON CONFLICT(event_key) DO NOTHING RETURNING event_key",
    [claimKey]
  );
  if (!claimed.rowCount) {
    await recordStaffPingAudit({kind:"duplicate",title:selected+" Conquest second run",
      eventKey:claimKey,actorId:interaction.user.id,
      detail:"Repeated second-run request blocked; this alert was already triggered today."}).catch(console.error);
    return interaction.editReply(
      (selected === "morning" ? "Morning" : "Night") +
      " Conquest second-run alert was already triggered today."
    );
  }

  const title = selected === "morning" ? "Morning Conquest" : "Night Conquest";
  const text = selected === "morning"
    ? "🌅 Morning Conquest — Second run is starting now!"
    : "🌌 Night Conquest — Second run is starting now!";

  try {
    const recipients = await sendLocalizedRoleNotification(
      REMINDERS[selected].role, text, title + " — Second Run",
      {actorId:interaction.user.id}
    );
    return interaction.editReply(
      title + " second-run alert sent. " +
      recipients + " subscriber(s) included in preferred-language groups."
    );
  } catch (error) {
    console.error("Conquest second-run manual alert failure:", error);
    return interaction.editReply(
      "The alert encountered an error. Today's second-run action is " +
      "locked to prevent accidental duplicate notifications; check Vestra's logs."
    );
  }
}
