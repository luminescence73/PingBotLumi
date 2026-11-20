import { LANGUAGE_KEYS, languageByChannel } from "../guild/languages.js";
import { client } from "../runtime/client.js";
import { pool } from "../runtime/database.js";
import { formatAttachments, limitText, safeDisplayName, sleep } from "../shared/discord.js";
import { LANGUAGE_CHANNELS } from "../../guildConfig.js";
import { googleTranslate } from "./google.js";

function translationAllowedMentions(message) {
  const mentions = getMentionIds(message.content || "");
  return {
    parse: message.mentions?.everyone ? ["everyone"] : [],
    users: mentions.users,
    roles: mentions.roles
  };
}

function getMentionIds(text) {
  const users = new Set();
  const roles = new Set();
  const regex = /<@!?(\d+)>|<@&(\d+)>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[1]) users.add(match[1]);
    if (match[2]) roles.add(match[2]);
  }
  return { users: [...users], roles: [...roles] };
}

const translationWebhooks = new Map();

const destinationChains = new Map(LANGUAGE_KEYS.map(key => [key, Promise.resolve()]));

async function getTranslationWebhook(channel, refresh = false) {
  if (refresh) translationWebhooks.delete(channel.id);
  if (translationWebhooks.has(channel.id)) return translationWebhooks.get(channel.id);
  const webhooks = await channel.fetchWebhooks();
  let webhook = webhooks.find(hook => hook.owner?.id === client.user.id && hook.name === "Vestra Translator");
  if (!webhook) webhook = await channel.createWebhook({ name: "Vestra Translator" });
  translationWebhooks.set(channel.id, webhook);
  return webhook;
}

function isInvalidTranslationWebhook(error) {
  return [10015, 50027].includes(Number(error?.code)) ||
    [401, 404].includes(Number(error?.status)) && /webhook/i.test(String(error?.message || ""));
}

function isRetryableTranslationError(error) {
  const status = Number(error?.status);
  const message = String(error?.message || "");
  return isInvalidTranslationWebhook(error) ||
    status === 429 || status >= 500 ||
    /Google Translation HTTP (429|5\d\d)\b/.test(message) ||
    /fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|timeout/i.test(message);
}

function queueDestination(languageKey, task) {
  const previous = destinationChains.get(languageKey) || Promise.resolve();
  const next = previous.then(async () => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        return await task();
      } catch (error) {
        console.error(`❌ ${languageKey} translation attempt ${attempt}/4:`, error);
        if (attempt === 4 || !isRetryableTranslationError(error)) {
          console.error(`🚨 Translation delivery failed for ${languageKey}; check Railway logs.`);
          return;
        }
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
      }
    }
  }).catch(error => {
    console.error(`❌ ${languageKey} translation queue unexpected error:`, error);
  });
  destinationChains.set(languageKey, next);
  return next;
}

export async function getGroupByMessageId(messageId) {
  const result = await pool.query(
    `SELECT tm.*, tg.source_message_id, tg.source_channel_id, tg.source_language,
            tg.author_id, tg.author_name, tg.author_avatar, tg.original_content,
            tg.attachment_urls, tg.reply_to_group_id
     FROM translation_messages tm
     JOIN translation_groups tg ON tg.group_id = tm.group_id
     WHERE tm.message_id = $1`,
    [messageId]
  );
  return result.rows[0] || null;
}

async function getTargetCopy(groupId, languageKey) {
  const result = await pool.query(
    "SELECT * FROM translation_messages WHERE group_id = $1 AND language_key = $2",
    [groupId, languageKey]
  );
  return result.rows[0] || null;
}

async function buildReplyHeader(replyToGroupId, targetLanguage, guildId) {
  if (!replyToGroupId) return "";
  const copy = await getTargetCopy(replyToGroupId, targetLanguage);
  if (!copy) return "↪️ **Reply**\n";
  const jump = `https://discord.com/channels/${guildId}/${copy.channel_id}/${copy.message_id}`;
  return `↪️ [**Replying to this message**](<${jump}>)\n`;
}

async function reactionSummary(groupId) {
  const result = await pool.query(
    `SELECT emoji_key, COUNT(DISTINCT user_id)::int AS count
     FROM message_reactions
     WHERE group_id = $1
     GROUP BY emoji_key
     ORDER BY count DESC, emoji_key ASC`,
    [groupId]
  );
  if (!result.rows.length) return "";
  return `\n\n—\n${result.rows.map(row => `${row.emoji_key} ${row.count}`).join("   ")}`;
}

async function editTranslatedCopy(row, content, allowedMentions = { parse: [] }) {
  const channel = await client.channels.fetch(row.channel_id).catch(() => null);
  if (!channel?.isTextBased()) return;
  const webhook = await getTranslationWebhook(channel);
  try {
    await webhook.editMessage(row.message_id, { content: limitText(content, 1990), allowedMentions });
  } catch (error) {
    if (error?.code === 10008) {
      await pool.query("DELETE FROM translation_messages WHERE message_id = $1", [row.message_id]);
    } else {
      throw error;
    }
  }
}

async function translatedBaseContent(message, sourceKey, targetKey, replyToGroupId) {
  const source = LANGUAGE_CHANNELS[sourceKey];
  const target = LANGUAGE_CHANNELS[targetKey];
  const translated = await googleTranslate(message.content || "", target.code, source.code);
  const reply = await buildReplyHeader(replyToGroupId, targetKey, message.guild.id);
  const attachments = formatAttachments(message.attachments);
  return limitText([reply.trimEnd(), translated, attachments].filter(Boolean).join("\n"), 1850);
}

async function createTranslatedCopy(message, groupId, sourceKey, targetKey, replyToGroupId) {
  const targetInfo = LANGUAGE_CHANNELS[targetKey];
  const sourceInfo = LANGUAGE_CHANNELS[sourceKey];
  const targetChannel = await client.channels.fetch(targetInfo.channel);
  if (!targetChannel?.isTextBased()) throw new Error(`${targetInfo.name} channel unavailable`);

  const base = await translatedBaseContent(message, sourceKey, targetKey, replyToGroupId);

  // A previous attempt may have delivered the message before a database error.
  // Never send a second copy when a mapping already exists.
  if (await getTargetCopy(groupId, targetKey)) return;

  const summary = await reactionSummary(groupId);
  const payload = {
    content: `${base}${summary}`,
    username: `${safeDisplayName(message.member, message.author)} • ${sourceInfo.emoji}`,
    avatarURL: message.author.displayAvatarURL({ extension: "png", size: 256 }),
    allowedMentions: translationAllowedMentions(message)
  };
  let webhook = await getTranslationWebhook(targetChannel);
  let sent;
  try {
    sent = await webhook.send(payload);
  } catch (error) {
    if (!isInvalidTranslationWebhook(error)) throw error;
    webhook = await getTranslationWebhook(targetChannel, true);
    sent = await webhook.send(payload);
  }

  await pool.query(
    `INSERT INTO translation_messages(message_id, group_id, channel_id, language_key, is_source, base_content, webhook_id)
     VALUES($1, $2, $3, $4, FALSE, $5, $6)
     ON CONFLICT(group_id, language_key) DO UPDATE SET
       message_id = EXCLUDED.message_id,
       channel_id = EXCLUDED.channel_id,
       base_content = EXCLUDED.base_content,
       webhook_id = EXCLUDED.webhook_id`,
    [sent.id, groupId, targetInfo.channel, targetKey, base, webhook.id]
  );

  console.log(`✅ Google translation ${sourceInfo.name} → ${targetInfo.name}: ${message.author.username}`);
}

export async function handleGeneralMessageCreate(message) {
  const sourceEntry = languageByChannel(message.channel.id);
  if (!sourceEntry) return;
  const [sourceKey] = sourceEntry;
  if (!message.content && message.attachments.size === 0) return;

  let replyToGroupId = null;
  if (message.reference?.messageId) {
    const referenced = await getGroupByMessageId(message.reference.messageId).catch(() => null);
    replyToGroupId = referenced?.group_id || null;
  }

  const attachmentURLs = [...message.attachments.values()].map(a => a.url);

  await pool.query(
    `INSERT INTO translation_groups(
       group_id, source_message_id, source_channel_id, source_language,
       author_id, author_name, author_avatar, original_content, attachment_urls, reply_to_group_id
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
     ON CONFLICT(group_id) DO NOTHING`,
    [
      message.id,
      message.id,
      message.channel.id,
      sourceKey,
      message.author.id,
      safeDisplayName(message.member, message.author),
      message.author.displayAvatarURL({ extension: "png", size: 256 }),
      message.content || "",
      JSON.stringify(attachmentURLs),
      replyToGroupId
    ]
  );

  await pool.query(
    `INSERT INTO translation_messages(message_id, group_id, channel_id, language_key, is_source, base_content)
     VALUES($1,$2,$3,$4,TRUE,$5)
     ON CONFLICT(message_id) DO NOTHING`,
    [message.id, message.id, message.channel.id, sourceKey, message.content || ""]
  );

  const destinations = LANGUAGE_KEYS.filter(key => key !== sourceKey);
  await Promise.all(destinations.map(key =>
    queueDestination(key, () => createTranslatedCopy(message, message.id, sourceKey, key, replyToGroupId))
  ));
}

export async function handleGeneralMessageUpdate(message) {
  const mapping = await getGroupByMessageId(message.id);
  if (!mapping?.is_source) return;

  const sourceKey = mapping.source_language;
  const attachmentURLs = [...message.attachments.values()].map(a => a.url);
  await pool.query(
    `UPDATE translation_groups
     SET original_content = $2, attachment_urls = $3::jsonb
     WHERE group_id = $1`,
    [mapping.group_id, message.content || "", JSON.stringify(attachmentURLs)]
  );

  const copies = await pool.query(
    "SELECT * FROM translation_messages WHERE group_id = $1 AND is_source = FALSE",
    [mapping.group_id]
  );
  const summary = await reactionSummary(mapping.group_id);

  await Promise.all(copies.rows.map(copy =>
    queueDestination(copy.language_key, async () => {
      const base = await translatedBaseContent(message, sourceKey, copy.language_key, mapping.reply_to_group_id);
      await pool.query("UPDATE translation_messages SET base_content = $2 WHERE message_id = $1", [copy.message_id, base]);
      await editTranslatedCopy(copy, `${base}${summary}`, translationAllowedMentions(message));
    })
  ));

  console.log(`✏️ Synced edit across translations: ${message.id}`);
}

export async function deleteTranslatedGroup(groupId) {
  const copies = await pool.query(
    "SELECT * FROM translation_messages WHERE group_id = $1 AND is_source = FALSE",
    [groupId]
  );
  for (const row of copies.rows) {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!channel?.isTextBased()) continue;
    try {
      const webhook = await getTranslationWebhook(channel);
      await webhook.deleteMessage(row.message_id);
    } catch {}
  }
  await pool.query("DELETE FROM translation_groups WHERE group_id = $1", [groupId]);
}

export async function updateReactionSummaries(groupId) {
  const summary = await reactionSummary(groupId);
  const copies = await pool.query(
    "SELECT * FROM translation_messages WHERE group_id = $1 AND is_source = FALSE",
    [groupId]
  );
  await Promise.all(copies.rows.map(({ language_key: key }) =>
    queueDestination(key, async () => {
      const row = await getTargetCopy(groupId, key);
      if (!row) return;
      await editTranslatedCopy(row, `${row.base_content || ""}${summary}`);
    })
  ));
}
