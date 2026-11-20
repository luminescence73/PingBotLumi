import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import { CHANNELS } from "../../guildConfig.js";
import { STAFF_ROLES } from "../../roleConfig.js";

function createHelpModal(customId, title, label, placeholder) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);

  const input = new TextInputBuilder()
    .setCustomId("help_details")
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(5)
    .setMaxLength(1000)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(input)
  );

  return modal;
}

async function createHelpThread(interaction, type, emoji, details) {
  const channel = await interaction.guild.channels.fetch(CHANNELS.HELP);

  if (!channel?.isTextBased()) {
    await interaction.reply({
      content: "❌ Vestra couldn't access the help channel.",
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  const post = await channel.send({
    content: [
      `# ${emoji} ${type}`,
      `**Requested by:** ${interaction.member}`,
      "",
      details
    ].join("\n"),
    embeds: [],
    allowedMentions: { parse: [] }
  });

  const safeName = `${type}-${interaction.user.username}`
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .slice(0, 90);

  const thread = await post.startThread({
    name: safeName,
    autoArchiveDuration: 1440
  });

  await thread.send({
    content: `${interaction.member}, your support thread is ready.`,
    allowedMentions: {
      parse: [],
      users: [interaction.user.id]
    }
  });

  await interaction.reply({
    content: `Request received: ${thread}`,
    flags: MessageFlags.Ephemeral
  });
}

export async function helpGame(interaction) {
  return interaction.showModal(createHelpModal("modal_game_help", "Game Help", "What do you need help with?", "Explain what you're stuck on..."));
}

export async function helpTeam(interaction) {
  return interaction.showModal(createHelpModal("modal_team_help", "Find a Team", "What are you looking for?", "Tell everyone what you need teammates for..."));
}

export async function helpStaff(interaction) {
  return interaction.showModal(createHelpModal("modal_staff_help", "Contact Ashen Staff", "What would you like staff to know?", "Explain your request or concern..."));
}

export async function helpDiscord(interaction) {
  return interaction.showModal(createHelpModal("modal_discord_help", "Discord Help", "What do you need help with?", "Explain the Discord or server issue..."));
}

export async function helpFaq(interaction) {
  return interaction.reply({
    content:
      "# ❓ Ashen FAQ\n\n" +
      `🌎 **Languages / notification language:** <#${CHANNELS.PREFERENCES}>\n` +
      `🔔 **Guild and tournament pings:** <#${CHANNELS.PREFERENCES}>\n` +
      "🌐 **Quick translation:** in supported text channels, react 🌐 to a message and Vestra will temporarily translate it into your primary language.\n" +
      "🛡️ **Private staff help:** use Ask Staff in this Help Center.",
    flags: MessageFlags.Ephemeral
  });
}

export async function helpGuide(interaction) {
  return interaction.reply({
    content:
      `# 🧭 Ashen Server Guide\n\n📍 <#${CHANNELS.START_HERE}> — Start here\n📜 <#${CHANNELS.RULES}> — Rules\n🌎 <#${CHANNELS.ONBOARDING}> — Onboarding\n✨ <#${CHANNELS.PREFERENCES}> — Vestra settings and alert subscriptions\n👋 <#${CHANNELS.INTRODUCTIONS}> — Introductions\n🆘 <#${CHANNELS.HELP}> — Help Center`,
    flags: MessageFlags.Ephemeral
  });
}

export async function modalGameHelp(interaction) {
  return createHelpThread(interaction, "Game Help", "🎮", interaction.fields.getTextInputValue("help_details"));
}

export async function modalTeamHelp(interaction) {
  return createHelpThread(interaction, "Looking for a Team", "👥", interaction.fields.getTextInputValue("help_details"));
}

export async function modalDiscordHelp(interaction) {
  return createHelpThread(interaction, "Discord Help", "⚙️", interaction.fields.getTextInputValue("help_details"));
}

export async function modalStaffHelp(interaction) {
  const details = interaction.fields.getTextInputValue("help_details");
  const staffChannel = await interaction.guild.channels.fetch(CHANNELS.STAFF_REQUESTS);

  if (!staffChannel?.isTextBased()) {
    return interaction.reply({
      content: "❌ Vestra couldn't reach the staff request channel.",
      flags: MessageFlags.Ephemeral
    });
  }

  await staffChannel.send({
    content: [
      `<@&${STAFF_ROLES.LEADER}> <@&${STAFF_ROLES.DEPUTY}> <@&${STAFF_ROLES.OFFICERS}>`,
      "",
      "# 🛡️ NEW STAFF REQUEST",
      `**Member:** ${interaction.member}`,
      `**Username:** ${interaction.user.username}`,
      "**Status:** New • Needs Review",
      "",
      details
    ].join("\n"),
    embeds: [],
    allowedMentions: {
      parse: [],
      roles: [
        STAFF_ROLES.LEADER,
        STAFF_ROLES.DEPUTY,
        STAFF_ROLES.OFFICERS
      ]
    }
  });

  return interaction.reply({
    content: "✅ Your message was sent privately to Ashen staff.",
    flags: MessageFlags.Ephemeral
  });
}
