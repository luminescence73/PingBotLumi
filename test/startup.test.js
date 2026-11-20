import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelType, Client, Collection, Events } from "discord.js";
import pg from "pg";
import { CHANNELS, LANGUAGE_CHANNELS } from "../guildConfig.js";
import { ONBOARDING_COMPLETE } from "../src/guild/access.js";

test("npm start entry point wires Discord events and runs database initialization and ready setup", async t => {
  const statements = [];
  const logs = [];
  const errors = [];
  let ready;
  t.mock.method(console, "log", line => logs.push(line));
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", (...args) => errors.push(args));
  t.mock.method(pg.Pool.prototype, "query", async sql => {
    statements.push(sql);
    if (sql.startsWith("SELECT COUNT(*) FILTER")) {
      return { rows: [{ sent: 0, delivered: 0, failed: 0, duplicates: 0, missed: 0, subscriptions: 0 }] };
    }
    if (sql.startsWith("SELECT 1 FROM sent_events")) return { rows: [{}] };
    return { rows: [], rowCount: 0 };
  });

  const previous = new Map();
  for (const key of ["DISCORD_BOT", "GOOGLE_TRANSLATE_API_KEY", "DATABASE_URL"]) {
    previous.set(key, process.env[key]);
    process.env[key] = "isolated-startup-test";
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(Client.prototype, "login", async function (token) {
    assert.equal(token, "isolated-startup-test");
    for (const event of [
      Events.GuildMemberAdd, Events.GuildMemberRemove, Events.GuildMemberUpdate,
      Events.MessageCreate, Events.MessageUpdate, Events.MessageDelete,
      Events.MessageReactionAdd, Events.MessageReactionRemove, Events.InteractionCreate,
      Events.ClientReady
    ]) {
      assert.equal(this.listenerCount(event), 1, event);
    }
    this.user = { id: "100", tag: "Vestra#0001" };
    t.mock.method(globalThis, "setInterval", () => {});
    t.mock.method(globalThis, "setTimeout", () => {});
    const channels = new Collection();
    const everyone = { id: "everyone" };
    const onboarded = { id: ONBOARDING_COMPLETE };
    const roles = new Collection([[everyone.id, everyone], [onboarded.id, onboarded]]);
    const people = new Collection();
    const allowed = { has: () => true };
    const denied = { has: () => false };
    const guild = {
      id: "guild", name: "Ashen Warriors",
      channels: { cache: channels, fetch: async id => id ? channels.get(id) : channels },
      roles: { cache: roles, everyone, fetch: async () => roles },
      members: {
        cache: people, fetch: async () => people,
        me: { id: this.user.id, permissions: allowed, roles: { highest: { position: 100 } } }
      }
    };
    const permissionOverwrites = { edit: async () => {}, set: async () => {} };
    channels.set("intel", { id: "intel", type: ChannelType.GuildCategory, name: "SWORD X STAFF | INTEL", permissionOverwrites });
    const panelWrites = [];
    for (const id of [...Object.values(CHANNELS), ...Object.values(LANGUAGE_CHANNELS).map(item => item.channel)]) {
      channels.set(id, {
        id, guild, name: id, type: ChannelType.GuildText, isTextBased: () => true, permissionOverwrites,
        permissionsFor: member => member === everyone || member === onboarded ? denied : allowed,
        messages: { fetch: async () => new Collection() },
        send: async payload => {
          for (const embed of payload.embeds || []) embed.toJSON();
          for (const row of payload.components || []) row.toJSON();
          panelWrites.push(id);
          return { id: String(panelWrites.length), reactions: { cache: new Collection() }, react: async () => {}, pin: async () => {} };
        }
      });
    }
    this.channels.cache.set(CHANNELS.START_HERE, channels.get(CHANNELS.START_HERE));
    t.mock.method(this.channels, "fetch", async id => channels.get(id) || null);
    t.mock.method(globalThis, "fetch", async () => ({
      ok: true, text: async () => "<p>Season 3 · Ashen · server day 30</p>"
    }));
    const [onReady] = this.listeners(Events.ClientReady);
    ready = onReady(this).then(() => {
      for (const id of [CHANNELS.ONBOARDING, CHANNELS.HELP, CHANNELS.EVENT_BOARD]) {
        assert.ok(panelWrites.includes(id), `startup should post panel in ${id}`);
      }
    });
    return token;
  });

  await import("../bot.js");
  assert.ok(ready);
  await ready;
  assert.ok(statements.some(sql => sql.includes("CREATE TABLE IF NOT EXISTS onboarding_sessions")));
  assert.ok(statements.some(sql => sql.includes("CREATE TABLE IF NOT EXISTS tournament_state")));
  assert.ok(logs.some(line => line.includes("Vestra online")));
  assert.ok(logs.some(line => line.includes("scheduler active")));
  assert.ok(logs.some(line => line.includes("Community Highlights active")));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []);
});
