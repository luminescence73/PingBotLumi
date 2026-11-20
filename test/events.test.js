import assert from "node:assert/strict";
import { test } from "node:test";
import { Collection } from "discord.js";
import { SCHEDULED_EVENTS, chicagoParts, eventApplies, eventTimeForDate } from "../src/events/schedule.js";
import { REMINDERS, TOURNAMENTS } from "../roleConfig.js";
import { pool } from "../src/runtime/database.js";
import { client } from "../src/runtime/client.js";
import { closeTournamentVote, startTournamentVote } from "../src/events/tournaments.js";
import { conquestSecondRunSelect } from "../src/events/staffConquest.js";
import { tournamentNext } from "../src/events/staffTournaments.js";
import { staffPingRefresh } from "../src/events/pingLog.js";
import { sendLocalizedRoleNotification } from "../src/events/notifications.js";
import { CHANNELS, LANGUAGE_CHANNELS } from "../guildConfig.js";

test("reminder schedules preserve Central time, DST and alternating Nexus and Chaos Sundays", () => {
  const sever = SCHEDULED_EVENTS.find(item => item.key === "server_tournament_start");
  const nexus = SCHEDULED_EVENTS.find(item => item.key === "nexus_tournament_start");
  const chaos = SCHEDULED_EVENTS.find(item => item.key === "chaos_tyrant_last_call");
  assert.deepEqual(eventTimeForDate(sever, 2026, 11, 7), sever.winter);
  assert.deepEqual(eventTimeForDate(sever, 2026, 11, 1), sever.winter);
  assert.deepEqual(eventTimeForDate(sever, 2027, 3, 14), sever.summer);
  assert.equal(chicagoParts(new Date("2026-11-20T06:00:00Z")).hour, 0);
  assert.equal(chicagoParts(new Date("2026-07-20T05:00:00Z")).hour, 0);
  assert.equal(eventApplies(nexus, 2026, 11, 8, 0), true);
  assert.equal(eventApplies(nexus, 2026, 11, 15, 0), false);
  assert.equal(eventApplies(nexus, 2026, 11, 22, 0), true);
  assert.equal(eventApplies(chaos, 2026, 11, 15, 0), true);
  assert.equal(eventApplies(chaos, 2026, 11, 22, 0), false);
});

test("Sever and Nexus preserve vote lengths and reject a duplicate round transition", async t => {
  const changes = [];
  let saved;
  t.mock.method(pool, "query", async (sql, args) => {
    assert.match(sql, /UPDATE tournament_state/);
    const [tournament, oldDate, oldRound, oldPhase, date, round, phase, end] = args;
    if (saved.tournament !== tournament || saved.active_date !== oldDate ||
        saved.round !== oldRound || saved.phase !== oldPhase) return { rowCount: 0 };
    saved = { tournament, active_date: date, round, phase, vote_ends_at: end };
    changes.push(saved);
    return { rowCount: 1 };
  });
  t.mock.method(client.channels, "fetch", async () => null);
  for (const [key, voteMinutes] of [["sever", 5], ["nexus", 10]]) {
    assert.equal(TOURNAMENTS[key].rounds, 4);
    saved = { tournament: key, active_date: "2026-11-20", round: 0, phase: "battle" };
    const battle = saved;
    const before = Date.now();
    assert.deepEqual(await Promise.all([
      startTournamentVote(battle, "staff-1"),
      startTournamentVote(battle, "staff-2")
    ]), [true, false]);
    const vote = changes.at(-1);
    assert.equal(vote.tournament, key);
    assert.equal(vote.round, 1);
    assert.equal(vote.phase, "voting");
    assert.ok(vote.vote_ends_at >= before + voteMinutes * 60_000);
    assert.ok(vote.vote_ends_at <= Date.now() + voteMinutes * 60_000);
    await closeTournamentVote(vote);
    assert.equal(saved.phase, "battle");
    saved = { ...vote, round: 4 };
    await closeTournamentVote(saved);
    assert.equal(saved.phase, "final_battle");
  }
});

test("staff-only controls refuse regular members and a refresh without channel privacy", async t => {
  const replies = [];
  const guild = {
    ownerId: "owner",
    members: { fetch: async id => ({ id, guild, roles: { cache: new Collection() } }) },
    roles: { cache: new Collection() }
  };
  const interaction = {
    guild, user: { id: "member" }, channelId: CHANNELS.REMINDERS,
    reply: async payload => replies.push(payload.content)
  };
  await tournamentNext(interaction);
  await conquestSecondRunSelect(interaction);
  await staffPingRefresh(interaction);
  assert.deepEqual(replies, [
    "❌ Only Ashen staff can advance tournament rounds.",
    "Only Ashen staff can send a second-run Conquest alert.",
    "Staff-only control."
  ]);
  t.mock.method(client.channels, "fetch", async () => null);
  await staffPingRefresh({ ...interaction, user: { id: "owner" } });
  assert.equal(replies.at(-1), "Staff monitor channel privacy cannot be verified.");
});


test("a multilingual reminder subscriber gets one ping in their saved notification language", async t => {
  const sends = [];
  const assigned = [];
  const french = LANGUAGE_CHANNELS.french;
  const english = LANGUAGE_CHANNELS.english;
  const member = {
    id: "member",
    user: { bot: false },
    roles: {
      cache: new Collection([[french.role, {}], [english.role, {}]]),
      add: async role => { assigned.push(role.id); }
    }
  };
  const subscribers = new Collection([[member.id, member]]);
  const subscription = { id: REMINDERS.reset.role, name: "Reset", members: subscribers };
  const helper = { id: "french-reset", mentionable: true, members: new Collection() };
  const channels = new Collection();
  const guild = {
    channels: { cache: channels, fetch: async () => channels },
    members: { cache: subscribers, fetch: async () => subscribers },
    roles: { fetch: async id => id === subscription.id ? subscription : helper }
  };
  client.channels.cache.set(CHANNELS.START_HERE, { guild });
  t.after(() => client.channels.cache.delete(CHANNELS.START_HERE));
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
  t.mock.method(client.channels, "fetch", async id => ({
    id, isTextBased: () => true, permissionsFor: () => ({ has: () => true }),
    send: async payload => sends.push({ id, payload })
  }));
  t.mock.method(globalThis, "fetch", async (_, options) => {
    assert.equal(JSON.parse(options.body).target, "fr");
    return { ok: true, json: async () => ({ data: { translations: [{ translatedText: "Rappel de réinitialisation" }] } }) };
  });
  t.mock.method(pool, "query", async sql => {
    if (sql.includes("FROM user_preferences")) {
      return { rows: [{ user_id: member.id, primary_language: "french" }] };
    }
    if (sql.includes("FROM localized_ping_roles")) {
      return { rows: [{ language_key: "french", scoped_role_id: helper.id }] };
    }
    assert.match(sql, /INSERT INTO guild_ping_staff_audit/);
    return { rowCount: 1 };
  });
  assert.equal(await sendLocalizedRoleNotification(subscription.id, "Reset reminder", "Reset"), 1);
  assert.deepEqual(assigned, [helper.id]);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].id, french.channel);
  assert.equal(sends[0].payload.content, "<@&french-reset>\nRappel de réinitialisation");
  assert.deepEqual(sends[0].payload.allowedMentions.roles, [helper.id]);
});
