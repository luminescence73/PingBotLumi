import { client } from "./client.js";
import { Events } from "discord.js";
import { keywordAlertMatches, sendKeywordAlert } from "../community/keywordAlerts.js";
import { ensureAshenMembersDiscussion, refreshAshenMembersPostInfo } from "../guild/showcase.js";
import { languageByChannel } from "../guild/languages.js";
import {
  deleteTranslatedGroup,
  getGroupByMessageId,
  handleGeneralMessageCreate,
  handleGeneralMessageUpdate,
  updateReactionSummaries
} from "../translation/general.js";
import { maybeHighlightGroup, maybeHighlightNative, removeHighlight } from "../community/highlights.js";
import { pool } from "./database.js";
import { reactionRole } from "../guild/members.js";
import {
  SOCIAL_TRANSLATE_EMOJI,
  handleSocialTranslationReaction,
  isReactionTranslateChannel
} from "../translation/social.js";
import { emojiKey } from "../shared/discord.js";

// Discord emits without waiting for async handlers. Keep a source message's
// create, edit and delete in order while other messages progress independently.
const pendingMessages = new Map();

function queueMessageEvent(event, getMessage, handle) {
  client.on(event, (...args) => {
    const message = getMessage(...args);
    const previous = pendingMessages.get(message.id) || Promise.resolve();
    const next = previous.then(() => handle(message)).catch(error => {
      console.error(`❌ ${event} handler:`, error);
    });
    pendingMessages.set(message.id, next);
    return next.finally(() => {
      if (pendingMessages.get(message.id) === next) pendingMessages.delete(message.id);
    });
  });
}

queueMessageEvent(Events.MessageCreate, message => message, async message => {
  if (!message.guild || message.author.bot || message.webhookId) return;
  if (keywordAlertMatches(message.content).length) {
    console.log("🔎 Live keyword detected:", message.channelId, message.id);
  }
  void sendKeywordAlert(message).catch(error => console.error("❌ Keyword monitor:", error));

  if (await ensureAshenMembersDiscussion(message)) return;
  if (languageByChannel(message.channel.id)) await handleGeneralMessageCreate(message);
});

queueMessageEvent(Events.MessageUpdate, (_, message) => message, async message => {
  if (message.partial) message = await message.fetch();
  if (!message.guild || message.author?.bot || message.webhookId) return;
  await refreshAshenMembersPostInfo(message);
  if (languageByChannel(message.channel.id)) await handleGeneralMessageUpdate(message);
});

queueMessageEvent(Events.MessageDelete, message => message, async message => {
  const mapping = await getGroupByMessageId(message.id).catch(() => null);
  if (mapping?.is_source) {
    await deleteTranslatedGroup(mapping.group_id);
    await removeHighlight(message.id);
    console.log(`🗑️ Deleted translated copies for ${message.id}`);
    return;
  }
  if (mapping) {
    await pool.query("DELETE FROM translation_messages WHERE message_id = $1", [message.id]);
    await pool.query("DELETE FROM message_reactions WHERE message_id = $1", [message.id]);
    return;
  }

  await removeHighlight(message.id);
});

async function handleReactionChange(reaction, user, adding) {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch();

  try {
    reaction.message = await reaction.message.fetch();
  } catch {
    if (reaction.message.partial) await reaction.message.fetch();
  }

  // Old reaction-role panels still work.
  await reactionRole(reaction, user, adding).catch(() => {});

  // In supported text channels, 🌐 is a translation request rather than a highlight reaction.
  if (adding && isReactionTranslateChannel(reaction.message.channel) && emojiKey(reaction.emoji) === SOCIAL_TRANSLATE_EMOJI) {
    await handleSocialTranslationReaction(reaction, user);
    return;
  }

  const mapping = await getGroupByMessageId(reaction.message.id).catch(() => null);
  if (mapping) {
    const key = emojiKey(reaction.emoji);
    if (adding) {
      await pool.query(
        `INSERT INTO message_reactions(message_id, group_id, user_id, emoji_key)
         VALUES($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [reaction.message.id, mapping.group_id, user.id, key]
      );
    } else {
      await pool.query(
        "DELETE FROM message_reactions WHERE message_id = $1 AND group_id = $2 AND user_id = $3 AND emoji_key = $4",
        [reaction.message.id, mapping.group_id, user.id, key]
      );
    }

    await updateReactionSummaries(mapping.group_id);
    if (adding) await maybeHighlightGroup(mapping.group_id);
    return;
  }

  if (adding) await maybeHighlightNative(reaction.message);
}

client.on(Events.MessageReactionAdd, (reaction, user) => {
  void handleReactionChange(reaction, user, true).catch(error => console.error("❌ Reaction add:", error));
});

client.on(Events.MessageReactionRemove, (reaction, user) => {
  void handleReactionChange(reaction, user, false).catch(error => console.error("❌ Reaction remove:", error));
});
