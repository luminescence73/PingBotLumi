import { BRAND_COLOR, emojiKey, limitText, safeDisplayName } from "../shared/discord.js";
import { CHANNELS } from "../../guildConfig.js";
import { client } from "../runtime/client.js";
import { pool } from "../runtime/database.js";
import { EmbedBuilder } from "discord.js";

const HIGHLIGHT_REACTION_THRESHOLD = 4;

function reactionStringFromMessage(message) {
  const entries = [...message.reactions.cache.values()]
    .map(reaction => ({ emoji: emojiKey(reaction.emoji), count: reaction.count || 0 }))
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count);
  return entries.map(x => `${x.emoji} ${x.count}`).join("   ");
}

async function upsertHighlight(sourceMessage, score, reactionText = "") {
  if (!sourceMessage || sourceMessage.author?.bot) return;
  if (sourceMessage.channel.id === CHANNELS.HIGHLIGHTS) return;

  const highlightChannel = await client.channels.fetch(CHANNELS.HIGHLIGHTS).catch(() => null);
  if (!highlightChannel?.isTextBased()) return;

  const existing = await pool.query(
    "SELECT * FROM highlights WHERE source_message_id = $1",
    [sourceMessage.id]
  );

  const firstImage = [...sourceMessage.attachments.values()].find(a => a.contentType?.startsWith("image/"));
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle("ASHEN | DISTINGUISHED")
    .setAuthor({
      name: safeDisplayName(sourceMessage.member, sourceMessage.author),
      iconURL: sourceMessage.author.displayAvatarURL({ size: 128 })
    })
    .setDescription(limitText(sourceMessage.content || "*(attachment / media post)*", 3500))
    .addFields(
      { name: "Community recognition", value: reactionText || `${score} reactions`, inline: true },
      { name: "↗ VIEW ORIGINAL", value: `[Jump to message](${sourceMessage.url})`, inline: true }
    )
    .setFooter({ text: "Vestra • Chosen by the Ashen community" })
    .setTimestamp(sourceMessage.createdAt);

  if (firstImage) embed.setImage(firstImage.url);

  if (existing.rows[0]) {
    const highlight = await highlightChannel.messages.fetch(existing.rows[0].highlight_message_id).catch(() => null);
    if (highlight) {
      await highlight.edit({ embeds: [embed] }).catch(() => {});
      await pool.query("UPDATE highlights SET score = $2 WHERE source_message_id = $1", [sourceMessage.id, score]);
      return;
    }
  }

  const sent = await highlightChannel.send({ embeds: [embed] });
  await pool.query(
    `INSERT INTO highlights(source_message_id, highlight_message_id, source_channel_id, score)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(source_message_id) DO UPDATE SET highlight_message_id = EXCLUDED.highlight_message_id, score = EXCLUDED.score`,
    [sourceMessage.id, sent.id, sourceMessage.channel.id, score]
  );
}

export async function removeHighlight(sourceMessageId) {
  const result = await pool.query("SELECT * FROM highlights WHERE source_message_id = $1", [sourceMessageId]);
  const row = result.rows[0];
  if (!row) return;
  const channel = await client.channels.fetch(CHANNELS.HIGHLIGHTS).catch(() => null);
  if (channel?.isTextBased()) {
    const message = await channel.messages.fetch(row.highlight_message_id).catch(() => null);
    if (message) await message.delete().catch(() => {});
  }
  await pool.query("DELETE FROM highlights WHERE source_message_id = $1", [sourceMessageId]);
}

export async function maybeHighlightGroup(groupId) {
  const reactions = await pool.query(
    `SELECT emoji_key, COUNT(DISTINCT user_id)::int AS count
     FROM message_reactions
     WHERE group_id = $1
     GROUP BY emoji_key
     ORDER BY count DESC, emoji_key ASC`,
    [groupId]
  );

  const total = reactions.rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  if (total < HIGHLIGHT_REACTION_THRESHOLD) return;

  const reactionText = reactions.rows.map(row => `${row.emoji_key} ${row.count}`).join("   ");
  const group = await pool.query("SELECT * FROM translation_groups WHERE group_id = $1", [groupId]);
  const row = group.rows[0];
  if (!row) return;
  const channel = await client.channels.fetch(row.source_channel_id).catch(() => null);
  if (!channel?.isTextBased()) return;
  const source = await channel.messages.fetch(row.source_message_id).catch(() => null);
  if (!source) return;
  await upsertHighlight(source, total, reactionText);
}

export async function maybeHighlightNative(message) {
  if (!message || message.author?.bot) return;
  const total = [...message.reactions.cache.values()].reduce((sum, r) => sum + (r.count || 0), 0);
  if (total < HIGHLIGHT_REACTION_THRESHOLD) return;
  await upsertHighlight(message, total, reactionStringFromMessage(message));
}
