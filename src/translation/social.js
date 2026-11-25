import { CHANNELS, LANGUAGE_CHANNELS } from "../../guildConfig.js";
import { IMPORTANT_CATEGORY_ID, SOCIAL_CATEGORY_ID, WELCOME_CATEGORY_ID } from "../guild/access.js";
import { pool } from "../runtime/database.js";
import { client } from "../runtime/client.js";
import { EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { emojiKey, limitText, safeDisplayName } from "../shared/discord.js";
import { googleTranslate, hasTranslatableText } from "./google.js";
import { inferPrimaryLanguage } from "../guild/preferences.js";

const EXTRA_REACTION_TRANSLATION_CHANNELS = new Set([
  "1507566115994472568", // SxS Media
  "1538251460351889599"  // SxS Resources
]);

const SOCIAL_CHANNELS = new Set([
  "1542252582469247016", // General
  "1542252701578961028", // Movies & Shows
  "1542252734076690442", // Other Gaming
  "1542252850808365226", // Foods
  "1542252884614184980", // Random Topics
  "1542252909222166628", // Memes
  "1542253001824272454", // Media
  "1542253232464601138"  // Music
]);

export const SOCIAL_TRANSLATE_EMOJI = "🌐";

const SOCIAL_TRANSLATION_DELETE_MS = 30_000;

export function isReactionTranslateChannel(channel) {
  if (!channel?.isTextBased?.()) return false;

  const automaticLanguageChannel = Object.values(LANGUAGE_CHANNELS)
    .some(info => info.channel === channel.id);

  if (automaticLanguageChannel) return false;

  return (
    SOCIAL_CHANNELS.has(channel.id) ||
    channel.parentId === SOCIAL_CATEGORY_ID ||
    channel.parentId === IMPORTANT_CATEGORY_ID ||
    channel.id === CHANNELS.REMINDERS ||
    channel.id === CHANNELS.HIGHLIGHTS ||
    channel.id === CHANNELS.EVENT_BOARD ||
    channel.parentId === WELCOME_CATEGORY_ID ||
    EXTRA_REACTION_TRANSLATION_CHANNELS.has(channel.id)
  );
}

export async function cleanupLegacySocialCompanions() {
  const result = await pool.query(
    "SELECT channel_id, companion_message_id FROM social_companions"
  );

  let removed = 0;

  for (const row of result.rows) {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!channel?.isTextBased()) continue;

    const companion = await channel.messages.fetch(row.companion_message_id).catch(() => null);
    if (!companion) continue;

    await companion.delete().catch(() => {});
    removed++;
  }

  await pool.query("DELETE FROM social_companions");

  if (result.rows.length) {
    console.log(`🧹 Removed ${removed} legacy Social Translate companion message(s).`);
  }
}

async function removeSocialTranslationReaction(reaction, userId) {
  const guild = reaction.message.guild;
  const me = guild?.members?.me || (guild ? await guild.members.fetchMe().catch(() => null) : null);
  const canManageMessages = me
    ? reaction.message.channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)
    : false;

  if (!canManageMessages) return;
  await reaction.users.remove(userId).catch(() => {});
}

const pendingTranslations = new Map();

export async function handleSocialTranslationButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith("vestra_translate:")) return false;
  const request = pendingTranslations.get(interaction.customId);
  if (!request || Date.now() >= request.expires) {
    await interaction.reply({ content: "This translation request expired. React with 🌐 again.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (interaction.user.id !== request.userId) {
    await interaction.reply({ content: "React with 🌐 to request your own private translation.", flags: MessageFlags.Ephemeral });
    return true;
  }
  pendingTranslations.delete(interaction.customId);
  clearTimeout(request.timer);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  void interaction.message.delete().catch(() => {});
  try {
    const message = await interaction.channel.messages.fetch(request.messageId);
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const target = LANGUAGE_CHANNELS[await inferPrimaryLanguage(member)];
    if (!message.content || !hasTranslatableText(message.content)) {
      await interaction.editReply({ content: "🌐 Vestra can only translate messages containing text." });
      return true;
    }
    const translated = await googleTranslate(message.content, target.code, null);
    const embed = new EmbedBuilder()
      .setAuthor({ name: safeDisplayName(message.member, message.author), iconURL: message.author.displayAvatarURL({ size: 128 }) })
      .setTitle(`${target.emoji} Translation → ${target.name}`)
      .setDescription(limitText(translated, 3900))
      .setFooter({ text: "Private translation • Vestra" });
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    console.error("❌ Private translation:", error.message);
    await interaction.editReply({ content: "🌐 Translation is temporarily unavailable. Please try again." }).catch(() => {});
  }
  return true;
}

export async function handleSocialTranslationReaction(reaction, user) {
  const message = reaction.message;
  if (!message?.guild || !isReactionTranslateChannel(message.channel) || emojiKey(reaction.emoji) !== SOCIAL_TRANSLATE_EMOJI) return false;
  const customId = `vestra_translate:${message.id}:${user.id}`;
  if (pendingTranslations.has(customId)) return true;
  const request = { userId: user.id, messageId: message.id, expires: Date.now() + SOCIAL_TRANSLATION_DELETE_MS };
  pendingTranslations.set(customId, request);
  try {
    const button = new ButtonBuilder().setCustomId(customId).setLabel("View private translation").setEmoji("🌐").setStyle(ButtonStyle.Secondary);
    const notice = await message.reply({ components: [new ActionRowBuilder().addComponents(button)], allowedMentions: { parse: [], repliedUser: false } });
    request.timer = setTimeout(() => {
      pendingTranslations.delete(customId);
      void notice.delete().catch(() => {});
    }, SOCIAL_TRANSLATION_DELETE_MS);
    await removeSocialTranslationReaction(reaction, user.id);
  } catch (error) {
    pendingTranslations.delete(customId);
    console.error("❌ Private translation button:", error.message);
  }
  return true;
}
