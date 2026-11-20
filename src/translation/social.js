import { CHANNELS, LANGUAGE_CHANNELS } from "../../guildConfig.js";
import { IMPORTANT_CATEGORY_ID, SOCIAL_CATEGORY_ID, WELCOME_CATEGORY_ID } from "../guild/access.js";
import { pool } from "../runtime/database.js";
import { client } from "../runtime/client.js";
import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
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

async function sendTemporarySocialNotice(message, content, deleteAfterMs = 10_000) {
  const notice = await message.reply({
    content,
    allowedMentions: { parse: [], repliedUser: false }
  }).catch(() => null);

  if (!notice) return;

  setTimeout(() => {
    void notice.delete().catch(() => {});
  }, deleteAfterMs);
}

export async function handleSocialTranslationReaction(reaction, user) {
  let message = reaction.message;

  try {
    message = await message.fetch();
  } catch {}

  if (!message?.guild) return false;
  if (!isReactionTranslateChannel(message.channel)) return false;
  if (emojiKey(reaction.emoji) !== SOCIAL_TRANSLATE_EMOJI) return false;

  console.log(`🌐 Translation requested in #${message.channel.name} by ${user.tag}`);

  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return true;

  const me = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
  const perms = me ? message.channel.permissionsFor(me) : null;
  const canSendHere = !!perms?.has(PermissionFlagsBits.SendMessages);

  await removeSocialTranslationReaction(reaction, user.id);

  if (!message.content || !hasTranslatableText(message.content)) {
    if (canSendHere) {
      await sendTemporarySocialNotice(
        message,
        "🌐 Vestra can only translate messages that contain text."
      );
    } else {
      await user.send("🌐 Vestra can only translate messages that contain text.").catch(() => {});
    }
    return true;
  }

  const targetKey = await inferPrimaryLanguage(member);
  const target = LANGUAGE_CHANNELS[targetKey];

  let translated;
  try {
    translated = await googleTranslate(message.content, target.code, null);
  } catch (error) {
    console.error("❌ Reaction translation:", error.message);

    const failureText = "🌐 Translation is temporarily unavailable. Please try again.";

    if (canSendHere) {
      await sendTemporarySocialNotice(message, failureText);
    } else {
      await user.send(failureText).catch(() => {});
    }

    return true;
  }

  const originalComparable = (message.content || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();

  const translatedComparable = (translated || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();

  if (originalComparable && originalComparable === translatedComparable) {
    const sameLanguageText = `${target.emoji} This message already appears to be in **${target.name}**.`;

    if (canSendHere) {
      await sendTemporarySocialNotice(message, sameLanguageText, 10_000);
    } else {
      await user.send(sameLanguageText).catch(() => {});
    }

    return true;
  }

  const requesterName = safeDisplayName(member, user);
  const makeTranslationEmbed = (temporary, secondsRemaining = 30) => {
    const translationEmbed = new EmbedBuilder()
      .setAuthor({
        name: safeDisplayName(message.member, message.author),
        iconURL: message.author?.displayAvatarURL?.({ size: 128 }) || undefined
      })
      .setTitle(`${target.emoji} Translation → ${target.name}`)
      .setDescription(limitText(translated, 3900));

    if (temporary) {
      translationEmbed.addFields({
        name: "⏳ Translation disappears in",
        value: secondsRemaining + (secondsRemaining === 1 ? " second" : " seconds")
      });
    }

    return translationEmbed.setFooter({
      text: temporary
        ? `Requested by ${requesterName} • Vestra`
        : `Requested by ${requesterName} • Vestra • DM fallback`
    });
  };

  let translatedReply = null;

  if (canSendHere) {
    translatedReply = await message.reply({
      embeds: [makeTranslationEmbed(true)],
      allowedMentions: { parse: [], repliedUser: false }
    }).catch(error => {
      console.error(`❌ Reaction translation reply in #${message.channel.name}:`, error.message);
      return null;
    });
  }

  if (!translatedReply) {
    console.warn(`⚠️ Could not reply in #${message.channel.name}; sending translation by DM instead.`);

    await user.send({
      content: `🌐 **Translation from #${message.channel.name}**\n${message.url}`,
      embeds: [makeTranslationEmbed(false)]
    }).catch(error => {
      console.error("❌ Translation DM fallback:", error.message);
    });

    return true;
  }

  // Discord's <t:...:R> is not a seconds-resolution countdown.
  // Update the same embed every second and delete it at the 30-second mark.
  const expiresAtMs = Date.now() + SOCIAL_TRANSLATION_DELETE_MS;
  let active = true;
  let editInFlight = false;
  let shownSeconds = 30;
  const countdown = setInterval(() => {
    if (!active || editInFlight) return;
    const remaining = Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
    if (remaining < 1 || remaining === shownSeconds) return;

    editInFlight = true;
    void translatedReply.edit({ embeds: [makeTranslationEmbed(true, remaining)] })
      .then(() => { shownSeconds = remaining; })
      .catch(error => {
        // If the message was removed or editing is no longer permitted,
        // stop updating; the deletion timeout still handles cleanup.
        console.warn("🌐 Translation countdown update failed:", error.message);
        if (error.code === 10008 || error.code === 50013) {
          active = false;
          clearInterval(countdown);
        }
      })
      .finally(() => { editInFlight = false; });
  }, 1000);

  setTimeout(() => {
    active = false;
    clearInterval(countdown);
    void translatedReply.delete().catch(() => {});
  }, SOCIAL_TRANSLATION_DELETE_MS);

  return true;
}
