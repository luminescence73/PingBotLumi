import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder
} from "discord.js";
import { brandEmbed } from "../shared/discord.js";
import { memberCardEmbed } from "./memberCards.js";
import { LANGUAGE_KEYS } from "./languages.js";
import { LANGUAGE_CHANNELS } from "../../guildConfig.js";
import { inferPrimaryLanguage, savePrimaryLanguage } from "./preferences.js";
import { PLAYSTYLE, REMINDERS, SOCIAL, TOURNAMENTS } from "../../roleConfig.js";

function settingsHomeComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("settings_languages").setLabel("Language Access").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("settings_notify").setLabel("Notification Language").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("settings_reminders").setLabel("Guild Pings").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("settings_tournaments").setLabel("Tournament Pings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("settings_playstyle").setLabel("Playstyle").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("settings_social").setLabel("Social").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("settings_card").setLabel("My Vestra Card").setStyle(ButtonStyle.Success)
    )
  ];
}

function settingsHomeEmbed() {
  return brandEmbed(
    "✦ VESTRA | SETTINGS",
    "Manage your access, alerts, and member profile."
  ).addFields(
    { name: "🌐 Language", value: "Channel access and notification language", inline: true },
    { name: "🔔 Alerts", value: "Guild and tournament subscriptions", inline: true },
    { name: "✧ Profile", value: "Playstyle and social preference", inline: true }
  ).setFooter({ text: "✦ Vestra | Changes save immediately" });
}

function backButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("settings_back").setLabel("Back").setStyle(ButtonStyle.Secondary)
  );
}

async function updateRoleSelection(member, group, selected) {
  for (const [key, { role }] of Object.entries(group)) {
    const hasRole = member.roles.cache.has(role);
    if (selected.has(key) && !hasRole) await member.roles.add(role).catch(() => {});
    if (!selected.has(key) && hasRole) await member.roles.remove(role).catch(() => {});
  }
}

function selectedSubscriptions(values) {
  return new Set(values.includes("none") ? [] : values);
}

function settingsMenuPayload(menu, title, description) {
  return {
    embeds: [new EmbedBuilder().setTitle(title).setDescription(description)],
    components: [new ActionRowBuilder().addComponents(menu), backButtonRow()]
  };
}

async function updateSingleChoiceRole(member, group, selectedKey) {
  for (const [key, item] of Object.entries(group)) {
    if (member.roles.cache.has(item.role) && key !== selectedKey) {
      await member.roles.remove(item.role).catch(() => {});
    }
  }
  if (selectedKey && group[selectedKey]) await member.roles.add(group[selectedKey].role);
}

export async function settingsOpen(interaction) {
  const payload = { embeds: [settingsHomeEmbed()], components: settingsHomeComponents() };
  if (interaction.message?.flags?.has?.(MessageFlags.Ephemeral)) return interaction.update(payload);
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

export async function settingsBack(interaction) {
  return interaction.update({ embeds: [settingsHomeEmbed()], components: settingsHomeComponents() });
}

export async function settingsCard(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const embed = await memberCardEmbed(member);
  if (interaction.message?.flags?.has?.(MessageFlags.Ephemeral)) {
    return interaction.update({ embeds: [embed], components: [backButtonRow()] });
  }
  return interaction.reply({ embeds: [embed], components: [backButtonRow()], flags: MessageFlags.Ephemeral });
}

export async function settingsLanguages(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const selected = LANGUAGE_KEYS.filter(key => member.roles.cache.has(LANGUAGE_CHANNELS[key].role));
  const menu = new StringSelectMenuBuilder()
    .setCustomId("settings_languages_select")
    .setPlaceholder("Choose every language channel you want")
    .setMinValues(1)
    .setMaxValues(LANGUAGE_KEYS.length)
    .addOptions(LANGUAGE_KEYS.map(key => ({
      label: LANGUAGE_CHANNELS[key].name,
      value: key,
      emoji: LANGUAGE_CHANNELS[key].emoji,
      default: selected.includes(key)
    })));
  return interaction.update(settingsMenuPayload(menu, "LANGUAGE ACCESS", "Choose every General language channel you want to see."));
}

export async function settingsLanguagesSelect(interaction) {
  await interaction.deferUpdate();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const selected = new Set(interaction.values);
  await updateRoleSelection(member, LANGUAGE_CHANNELS, selected);
  const primary = await inferPrimaryLanguage(member);
  if (!selected.has(primary)) await savePrimaryLanguage(member.id, interaction.values[0]);
  return interaction.editReply({
    embeds: [brandEmbed("✅ Language Access Updated", "Your language channel access has been saved.")],
    components: [backButtonRow()]
  });
}

export async function settingsNotify(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const current = await inferPrimaryLanguage(member);
  const menu = new StringSelectMenuBuilder()
    .setCustomId("settings_notify_select")
    .setPlaceholder("Choose one notification language")
    .addOptions(LANGUAGE_KEYS.map(key => ({
      label: LANGUAGE_CHANNELS[key].name,
      value: key,
      emoji: LANGUAGE_CHANNELS[key].emoji,
      default: current === key
    })));
  return interaction.update(settingsMenuPayload(menu, "NOTIFICATION LANGUAGE", "Vestra sends your event pings **once**, in this language's General channel."));
}

export async function settingsNotifySelect(interaction) {
  await interaction.deferUpdate();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const key = interaction.values[0];
  if (!member.roles.cache.has(LANGUAGE_CHANNELS[key].role)) await member.roles.add(LANGUAGE_CHANNELS[key].role);
  await savePrimaryLanguage(member.id, key);
  return interaction.editReply({
    embeds: [brandEmbed(
      "✅ Notification Language Updated",
      `${LANGUAGE_CHANNELS[key].emoji} Vestra will notify you in **${LANGUAGE_CHANNELS[key].name}**.`
    )],
    components: [backButtonRow()]
  });
}

export async function settingsReminders(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const selected = Object.entries(REMINDERS).filter(([, item]) => member.roles.cache.has(item.role)).map(([key]) => key);
  const menu = new StringSelectMenuBuilder()
    .setCustomId("settings_reminders_select")
    .setPlaceholder("Select guild alerts")
    .setMinValues(1)
    .setMaxValues(Object.keys(REMINDERS).length + 1)
    .addOptions(
      ...Object.entries(REMINDERS).map(([key, item]) => ({ label: item.name, value: key, emoji: item.emoji, default: selected.includes(key) })),
      { label: "No game pings", value: "none", emoji: "🔕", default: selected.length === 0 }
    );
  return interaction.update(settingsMenuPayload(menu, "⏰ Guild Pings", "Choose the guild reminders you want to receive in your preferred language."));
}

export async function settingsRemindersSelect(interaction) {
  await interaction.deferUpdate();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  await updateRoleSelection(member, REMINDERS, selectedSubscriptions(interaction.values));
  return interaction.editReply({
    embeds: [brandEmbed("✅ Game Pings Updated", "Your game and guild reminder choices have been saved.")],
    components: [backButtonRow()]
  });
}

export async function settingsTournaments(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const selected = Object.entries(TOURNAMENTS).filter(([, item]) => member.roles.cache.has(item.role)).map(([key]) => key);
  const menu = new StringSelectMenuBuilder()
    .setCustomId("settings_tournaments_select")
    .setPlaceholder("Choose tournament alerts")
    .setMinValues(1)
    .setMaxValues(3)
    .addOptions(
      { label: "Server Tournament", value: "sever", emoji: "⚔️", default: selected.includes("sever") },
      { label: "Nexus Tournament", value: "nexus", emoji: "🌀", default: selected.includes("nexus") },
      { label: "No tournament pings", value: "none", emoji: "🔕", default: selected.length === 0 }
    );
  return interaction.update(settingsMenuPayload(menu, "TOURNAMENT ALERTS", "Opt in to Server Tournament, Nexus Tournament, both, or neither."));
}

export async function settingsTournamentsSelect(interaction) {
  await interaction.deferUpdate();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  await updateRoleSelection(member, TOURNAMENTS, selectedSubscriptions(interaction.values));
  return interaction.editReply({
    embeds: [brandEmbed("✅ Tournament Pings Updated", "Your Server Tournament and Nexus Tournament alert choices have been saved.")],
    components: [backButtonRow()]
  });
}

export async function settingsPlaystyle(interaction) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("settings_playstyle_select")
    .setPlaceholder("Choose your playstyle")
    .addOptions(
      ...Object.entries(PLAYSTYLE).map(([key, item]) => ({ label: item.name, value: key, emoji: item.emoji })),
      { label: "None", value: "none", emoji: "⏭️" }
    );
  return interaction.update({ embeds: [new EmbedBuilder().setTitle("PLAYSTYLE")], components: [new ActionRowBuilder().addComponents(menu), backButtonRow()] });
}

export async function settingsPlaystyleSelect(interaction) {
  await interaction.deferUpdate();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const selected = interaction.values[0] === "none" ? null : interaction.values[0];
  await updateSingleChoiceRole(member, PLAYSTYLE, selected);
  return interaction.editReply({
    embeds: [brandEmbed("✅ Playstyle Updated", "Your playstyle has been saved.")],
    components: [backButtonRow()]
  });
}

export async function settingsSocial(interaction) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("settings_social_select")
    .setPlaceholder("Choose your social preference")
    .addOptions(
      ...Object.entries(SOCIAL).map(([key, item]) => ({ label: item.name, value: key, emoji: item.emoji })),
      { label: "None", value: "none", emoji: "⏭️" }
    );
  return interaction.update({ embeds: [new EmbedBuilder().setTitle("SOCIAL")], components: [new ActionRowBuilder().addComponents(menu), backButtonRow()] });
}

export async function settingsSocialSelect(interaction) {
  await interaction.deferUpdate();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const selected = interaction.values[0] === "none" ? null : interaction.values[0];
  await updateSingleChoiceRole(member, SOCIAL, selected);
  return interaction.editReply({
    embeds: [brandEmbed("✅ Social Preference Updated", "Your social preference has been saved.")],
    components: [backButtonRow()]
  });
}
