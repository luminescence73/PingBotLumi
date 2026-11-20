import { EmbedBuilder } from "discord.js";

export const BOT_NAME = "Vestra";

export const BRAND_COLOR = 0x363B41;

export function limitText(text, max = 1900) {
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

export function safeDisplayName(member, user) {
  return member?.displayName || user?.globalName || user?.username || "Member";
}

export function formatAttachments(attachments) {
  return [...attachments.values()].map(a => `📎 ${a.url}`).join("\n");
}

export function emojiKey(emoji) {
  if (emoji.id) return emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
  return emoji.name;
}

export function brandEmbed(title, description = "") {
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(title);

  if (description) embed.setDescription(description);
  return embed;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
