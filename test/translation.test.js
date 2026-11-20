import assert from "node:assert/strict";
import { test } from "node:test";
import { Collection, Events } from "discord.js";
import { LANGUAGE_CHANNELS } from "../guildConfig.js";
import { client } from "../src/runtime/client.js";
import { pool } from "../src/runtime/database.js";
import "../src/runtime/messages.js";

test("translated General preserves mentions, replies and attachments and orders create, edit and delete", async t => {
  const groups = new Map();
  const copies = new Map();
  const sent = [];
  const edited = [];
  const deleted = [];
  const requests = new Map();
  const channels = new Map();
  const guild = { id: "guild", channels: { cache: new Collection() } };
  client.user = { id: "vestra" };
  t.after(() => { client.user = null; });
  t.mock.method(console, "log", () => {});
  const errors = [];
  t.mock.method(console, "error", (...error) => errors.push(error));
  for (const info of Object.values(LANGUAGE_CHANNELS)) {
    const channel = { id: info.channel, isTextBased: () => true };
    const webhook = {
      id: `hook-${info.code}`, owner: client.user, name: "Vestra Translator",
      send: async payload => {
        const id = String(100 + sent.length);
        sent.push({ id, payload, info });
        return { id };
      },
      editMessage: async (id, payload) => edited.push({ id, payload }),
      deleteMessage: async id => deleted.push(id)
    };
    channel.fetchWebhooks = async () => new Collection([[webhook.id, webhook]]);
    channels.set(channel.id, channel);
  }
  t.mock.method(client.channels, "fetch", async id => channels.get(id) || null);

  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(url, /translation\.googleapis\.com/);
    const body = JSON.parse(options.body);
    assert.equal(body.source, "en");
    assert.doesNotMatch(body.q, /@everyone|@here|https:\/\/example\.com\/link/);
    const key = body.target + body.q;
    const attempt = (requests.get(key) || 0) + 1;
    requests.set(key, attempt);
    if (body.target === "fr" && body.q.startsWith("First") && attempt === 1) {
      return { ok: false, status: 503, text: async () => "temporary outage" };
    }
    return { ok: true, json: async () => ({
      data: { translations: [{ translatedText: `${body.target}: ${body.q}` }] }
    }) };
  });

  t.mock.method(pool, "query", async (sql, args) => {
    const query = sql.trim();
    if (query.startsWith("INSERT INTO translation_groups")) {
      groups.set(args[0], { group_id: args[0], source_language: args[3], reply_to_group_id: args[9] });
    } else if (query.startsWith("INSERT INTO translation_messages")) {
      const [message_id, group_id, channel_id, language_key] = args;
      copies.set(message_id, { message_id, group_id, channel_id, language_key, is_source: query.includes("TRUE") });
    } else if (query.includes("JOIN translation_groups")) {
      const message = copies.get(args[0]);
      return { rows: message ? [{ ...message, ...groups.get(message.group_id) }] : [] };
    } else if (query.includes("WHERE group_id = $1 AND language_key = $2")) {
      return { rows: [...copies.values()].filter(row => row.group_id === args[0] && row.language_key === args[1]) };
    } else if (query.includes("WHERE group_id = $1 AND is_source = FALSE")) {
      return { rows: [...copies.values()].filter(row => row.group_id === args[0] && !row.is_source) };
    } else if (query.startsWith("DELETE FROM translation_groups")) {
      groups.delete(args[0]);
      for (const [id, row] of copies) if (row.group_id === args[0]) copies.delete(id);
    } else if (!/^(SELECT emoji_key|UPDATE translation_(groups|messages)|SELECT .* FROM highlights)/s.test(query)) {
      assert.fail("unexpected query: " + query);
    }
    return { rows: [] };
  });

  const english = LANGUAGE_CHANNELS.english;
  const [create] = client.listeners(Events.MessageCreate);
  const [update] = client.listeners(Events.MessageUpdate);
  const [remove] = client.listeners(Events.MessageDelete);
  const message = {
    id: "source-1", guild, channel: channels.get(english.channel), channelId: english.channel,
    content: "First @everyone <@123> <@&456> `keep this` https://example.com/link",
    mentions: { everyone: true },
    author: { id: "member", username: "lumi", displayAvatarURL: () => "https://example.com/avatar.png" },
    attachments: new Collection([["file", { url: "https://example.com/attachment" }]])
  };
  await create(message);
  assert.equal(sent.length, 5);
  for (const { payload } of sent) {
    assert.match(payload.content, /@everyone <@123> <@&456> `keep this` https:\/\/example\.com\/link/);
    assert.match(payload.content, /📎 https:\/\/example\.com\/attachment/);
    assert.deepEqual(payload.allowedMentions, { parse: ["everyone"], users: ["123"], roles: ["456"] });
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /french translation attempt 1\/4/);

  const reply = {
    ...message, id: "source-2", reference: { messageId: message.id },
    content: "Reply with literal @here", mentions: { everyone: false }
  };
  const created = create(reply);
  const updated = update(reply, { ...reply, content: "Updated reply @here" });
  const removed = remove(reply);
  await Promise.all([created, updated, removed]);

  assert.equal(sent.length, 10);
  for (const { info, payload } of sent.slice(5)) {
    const sourceCopy = sent.find(item => item.info === info);
    assert.ok(payload.content.includes(`/guild/${info.channel}/${sourceCopy.id}>`));
    assert.match(payload.content, /literal @here/);
    assert.deepEqual(payload.allowedMentions.parse, []);
  }
  assert.deepEqual(edited.map(item => item.id).sort(), sent.slice(5).map(item => item.id).sort());
  assert.ok(edited.every(item => item.payload.content.includes("Updated reply @here")));
  assert.deepEqual(deleted.sort(), sent.slice(5).map(item => item.id).sort());
  assert.equal(groups.has(reply.id), false);
  assert.equal(groups.has(message.id), true);
  assert.equal(errors.length, 1);
});
