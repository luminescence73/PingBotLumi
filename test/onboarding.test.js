import assert from "node:assert/strict";
import { test } from "node:test";
import { Collection, Events } from "discord.js";
import { CHANNELS, LANGUAGE_CHANNELS } from "../guildConfig.js";
import { PLAYSTYLE, REMINDERS, STAFF_ROLES, TOURNAMENTS } from "../roleConfig.js";
import { ASHEN_WARRIORS, ONBOARDING_COMPLETE } from "../src/guild/access.js";
import { upsertRecruitIntroduction } from "../src/guild/memberCards.js";
import { pool } from "../src/runtime/database.js";
import { client } from "../src/runtime/client.js";
import "../src/runtime/interactions.js";

function rolesFor(ids) {
  const cache = new Collection(ids.map(id => [id, { id }]));
  return {
    cache,
    add: async ids => ids.forEach(id => cache.set(id, { id })),
    remove: async ids => ids.forEach(id => cache.delete(id))
  };
}

test("existing onboarding buttons and menus persist choices and protect staff roles", async t => {
  const writes = [];
  t.mock.method(pool, "query", async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  });
  const id = "200000001";
  const roles = rolesFor([STAFF_ROLES.ADMIN, LANGUAGE_CHANNELS.english.role, ASHEN_WARRIORS]);
  const member = { id, roles };
  const guild = { members: { fetch: async () => member }, channels: { fetch: async () => null } };
  const reply = [];
  const [dispatch] = client.listeners(Events.InteractionCreate);
  async function click(customId, values) {
    const interaction = {
      customId, guild, user: { id }, values,
      isButton: () => !values, isStringSelectMenu: () => Boolean(values), isModalSubmit: () => false,
      deferReply: async () => {}, deferUpdate: async () => {},
      editReply: async value => reply.push(value)
    };
    await dispatch(interaction);
    const last = reply.at(-1);
    return last.components.flatMap(row => row.toJSON().components.map(item => item.custom_id));
  }
  assert.deepEqual(await click("start_onboarding"), ["onboard_language"]);
  assert.deepEqual(await click("onboard_language", ["french"]), ["onboard_reminders"]);
  assert.deepEqual(await click("onboard_reminders", ["morning", "tournament:nexus"]), ["onboard_playstyle"]);
  assert.deepEqual(await click("onboard_playstyle", ["casual"]), ["onboard_social"]);
  assert.deepEqual(await click("onboard_social", ["skip"]), ["onboard_finish"]);
  assert.deepEqual(await click("onboard_finish"), []);
  assert.deepEqual(new Set(roles.cache.keys()), new Set([
    STAFF_ROLES.ADMIN, ASHEN_WARRIORS, ONBOARDING_COMPLETE, LANGUAGE_CHANNELS.french.role,
    PLAYSTYLE.casual.role, REMINDERS.morning.role, TOURNAMENTS.nexus.role
  ]));
  assert.ok(writes.some(({ sql, params }) => sql.includes("INSERT INTO user_preferences") && params[1] === "french"));
  assert.ok(writes.some(({ sql }) => sql.includes("DELETE FROM onboarding_sessions")));
});

test("repeat onboarding edits the oldest matching card without touching a namesake's card", async t => {
  t.mock.method(client.channels, "fetch", async () => null);
  client.user = { id: "vestra" };
  t.after(() => { client.user = null; });
  const member = {
    id: "222222",
    displayName: "Lumi",
    user: { username: "lumi", displayAvatarURL: () => "https://example.com/avatar.png" }
  };
  const edited = [];
  const deleted = [];
  const makeCard = (id, memberId, time) => ({
    id, content: `<@${memberId}>`, author: { id: client.user.id },
    embeds: [{ title: "ASHEN | NEW RECRUIT", description: "**Lumi** has completed induction" }],
    createdTimestamp: time, createdAt: new Date(time),
    edit: async function (payload) { edited.push([id, payload.content]); return this; },
    delete: async () => deleted.push(id)
  });
  const namesake = makeCard("other-card", "333333", 1);
  const original = makeCard("original", member.id, 2);
  const duplicate = makeCard("duplicate", member.id, 3);
  const messages = new Collection([namesake, original, duplicate].map(card => [card.id, card]));
  const intro = {
    id: CHANNELS.INTRODUCTIONS,
    messages: { fetch: async () => messages },
    send: async () => assert.fail("should edit an existing card")
  };
  assert.equal(await upsertRecruitIntroduction(intro, member, "French", "Casual", "Quiet"), original);
  assert.deepEqual(edited, [["original", "<@222222>"]]);
  assert.deepEqual(deleted, ["duplicate"]);
});
