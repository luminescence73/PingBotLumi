import assert from "node:assert/strict";
import { test } from "node:test";
import { Collection } from "discord.js";
import { SCHEDULED_EVENTS, chicagoParts, eventApplies, eventTimeForDate } from "../src/events/schedule.js";
import { TOURNAMENTS } from "../roleConfig.js";
import { pool } from "../src/runtime/database.js";
import { client } from "../src/runtime/client.js";
import { closeTournamentVote, startTournamentVote } from "../src/events/tournaments.js";
import { conquestSecondRunSelect } from "../src/events/staffConquest.js";
import { tournamentNext } from "../src/events/staffTournaments.js";
import { staffPingRefresh } from "../src/events/pingLog.js";
import { CHANNELS } from "../guildConfig.js";

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

test("Sever and Nexus retain their vote lengths and four rounds", async t => {
  const changes = [];
  t.mock.method(pool, "query", async (sql, args) => {
    assert.match(sql, /INSERT INTO tournament_state/);
    changes.push(args);
    return { rows: [] };
  });
  t.mock.method(client.channels, "fetch", async () => null);
  for (const [key, voteMinutes] of [["sever", 5], ["nexus", 10]]) {
    assert.equal(TOURNAMENTS[key].rounds, 4);
    const before = Date.now();
    await startTournamentVote(key, 1, false);
    const [tournament, date, round, phase, end] = changes.at(-1);
    assert.equal(tournament, key);
    assert.equal(round, 1);
    assert.equal(phase, "voting");
    assert.ok(end >= before + voteMinutes * 60_000);
    assert.ok(end <= Date.now() + voteMinutes * 60_000);
    await closeTournamentVote({ tournament, active_date: date, round: 1 });
    assert.equal(changes.at(-1)[3], "battle");
    await closeTournamentVote({ tournament, active_date: date, round: 4 });
    assert.equal(changes.at(-1)[3], "final_battle");
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
