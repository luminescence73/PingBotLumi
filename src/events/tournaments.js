import { dbGetState, dbSetState, pool } from "../runtime/database.js";
import { TOURNAMENTS } from "../../roleConfig.js";
import { chicagoParts, dateKey, eventDayLabel, format12Hour, isCentralDSTDate, upcomingEvents } from "./schedule.js";
import { sendLocalizedRoleNotification } from "./notifications.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { BRAND_COLOR } from "../shared/discord.js";
import { client } from "../runtime/client.js";
import { CHANNELS } from "../../guildConfig.js";

export async function getActiveTournamentState() {
  const result = await pool.query(
    "SELECT * FROM tournament_state WHERE phase <> 'inactive' AND phase <> 'complete' ORDER BY updated_at DESC LIMIT 1"
  );
  return result.rows[0] || null;
}

async function setTournamentState(tournament, activeDate, round, phase, voteEndsAt = null) {
  await pool.query(
    `INSERT INTO tournament_state(tournament, active_date, round, phase, vote_ends_at, updated_at)
     VALUES($1,$2,$3,$4,$5,NOW())
     ON CONFLICT(tournament) DO UPDATE SET
       active_date = EXCLUDED.active_date,
       round = EXCLUDED.round,
       phase = EXCLUDED.phase,
       vote_ends_at = EXCLUDED.vote_ends_at,
       updated_at = NOW()`,
    [tournament, activeDate, round, phase, voteEndsAt]
  );
}

export async function startTournamentEvent(tournamentKey, announcementText, label) {
  const tournament = TOURNAMENTS[tournamentKey];
  const parts = chicagoParts();

  await setTournamentState(
    tournamentKey,
    dateKey(parts),
    0,
    "battle",
    null
  );

  await sendLocalizedRoleNotification(
    tournament.role,
    announcementText,
    label
  );

  await updateEventBoard();
}

export async function startTournamentVote(tournamentKey, round, pingMembers = true, actorId = null) {
  const tournament = TOURNAMENTS[tournamentKey];
  const parts = chicagoParts();
  const ends = new Date(Date.now() + tournament.voteMinutes * 60 * 1000);
  await setTournamentState(tournamentKey, dateKey(parts), round, "voting", ends);

  if (pingMembers) {
    await sendLocalizedRoleNotification(
      tournament.role,
      `🗳️ ${tournament.name} Round ${round} voting is OPEN! You have ${tournament.voteMinutes} minutes to vote.`,
      `${tournament.name} — Round ${round} Voting Open`,
      {actorId}
    );
  }

  await updateEventBoard();
}

export async function closeTournamentVote(state) {
  const tournament = TOURNAMENTS[state.tournament];
  const phase = state.round >= tournament.rounds ? "final_battle" : "battle";
  await setTournamentState(state.tournament, state.active_date, state.round, phase, null);
  await updateEventBoard();
}

export async function finishTournament(tournamentKey) {
  const parts = chicagoParts();
  await setTournamentState(tournamentKey, dateKey(parts), 0, "complete", null);
  await updateEventBoard();
}

function countdownText(relativeMinutes) {
  const days = Math.floor(relativeMinutes / 1440);
  const hours = Math.floor((relativeMinutes % 1440) / 60);
  const minutes = relativeMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${Math.max(minutes, 0)}m`;
}

function eventBoardDefaultEmbeds() {
  const events = upcomingEvents(6);
  const next = events[0];
  const future = events.slice(1);
  const now = chicagoParts();
  const schedule = isCentralDSTDate(now.year, now.month, now.day)
    ? "Daylight Saving Time" : "Standard Time";

  const upcoming = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor({ name: "ASHEN / WAR BOARD" })
    .setTitle("NEXT OPERATION")
    .setDescription(
      next
        ? `**${next.label.toUpperCase()}**
${eventDayLabel(next)} | ${format12Hour(next.hour, next.minute)}

**IN ${countdownText(next.relativeMinutes)}**`
        : "No upcoming operations scheduled."
    )
    .setFooter({ text: "Vestra | Live Schedule" })
    .setTimestamp();

  const following = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle("UPCOMING OPERATIONS")
    .setDescription(
      future.length
        ? future.map(e =>
          `**${e.label}** — ${eventDayLabel(e)} ${format12Hour(e.hour, e.minute)}
In ${countdownText(e.relativeMinutes)}`
        ).join("\n\n")
        : "No further operations currently scheduled."
    )
    .addFields({ name: "Schedule", value: schedule })
    .setFooter({ text: "Vestra | Ashen Operations" });

  return [upcoming, following];
}

async function eventBoardPayload() {
  const state = await getActiveTournamentState();

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("settings_open")
        .setLabel("My Settings")
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId("settings_card")
        .setLabel("My Vestra Card")
        .setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("conquest_second_run")
        .setLabel("Conquest — Second Run")
        .setStyle(ButtonStyle.Primary)
    )
  ];

  if (!state) {
    return {
      embeds: eventBoardDefaultEmbeds(),
      components: rows
    };
  }

  const tournament = TOURNAMENTS[state.tournament];

  const title =
    state.round > 0
      ? `${tournament.name.toUpperCase()} | ROUND ${state.round}/${tournament.rounds}`
      : `${tournament.name.toUpperCase()} | LIVE`;

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor({
      name: "ASHEN / TOURNAMENT COMMAND"
    })
    .setTitle(title)
    .setFooter({
      text: "Vestra • Tournament Mode"
    })
    .setTimestamp();

  if (state.phase === "voting") {
    const unix = Math.floor(
      new Date(state.vote_ends_at).getTime() / 1000
    );

    embed
      .setDescription(
        `# VOTING OPEN

## ROUND ${state.round} / ${tournament.rounds}

**Cast your vote now.**
Voting closes <t:${unix}:R>.`
      )
      .addFields(
        {
          name: "Voting window",
          value: `<t:${unix}:R> • closes at <t:${unix}:t>`
        },
        {
          name: "Next phase",
          value: "When voting closes, Vestra switches the board back to **Battle in Progress**. Staff will manually open the next vote when the battle actually ends."
        }
      );
  } else if (state.phase === "battle") {
    const nextRound = state.round + 1;

    embed
      .setDescription(
        state.round === 0
          ? `# BATTLE IN PROGRESS

## ${tournament.name.toUpperCase()} IS LIVE

The tournament battle is underway.
Ashen staff will manually open **Vote 1** when the battle is ready.`
          : `# BATTLE IN PROGRESS

## ROUND ${state.round} COMPLETE

Voting is closed while the battle plays out.
The next voting round will open manually when the battle is ready.`
      )
      .addFields({
        name: "Next vote",
        value: `Staff will manually open **Round ${nextRound}** when the battle is ready.`
      });

    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("tournament_next")
          .setLabel(`Start Vote ${nextRound}`)

          .setStyle(ButtonStyle.Success)
      )
    );
  } else if (state.phase === "final_battle") {
    embed
      .setDescription(
        `# FINAL BATTLE

## ALL 4 VOTING ROUNDS COMPLETE

The last battle is underway.
When it ends, staff can close Tournament Mode and return to the normal event board.`
      )
      .addFields({
        name: "Finish",
        value: "When the final battle ends, staff can finish Tournament Mode and return the board to the normal upcoming-event view."
      });

    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("tournament_finish")
          .setLabel("Finish Tournament")

          .setStyle(ButtonStyle.Primary)
      )
    );
  }

  return {
    embeds: [embed],
    components: rows
  };
}

export async function setupEventBoard() {
  const channel = await client.channels.fetch(CHANNELS.EVENT_BOARD);
  if (!channel?.isTextBased()) return;

  let state = await dbGetState("event_board_message");
  let message = state?.messageId ? await channel.messages.fetch(state.messageId).catch(() => null) : null;

  if (!message) {
    const recent = await channel.messages.fetch({ limit: 50 });
    message = recent.find(
      m =>
        m.author.id === client.user.id &&
        (
          m.embeds?.[0]?.footer?.text?.includes("Live Event Board") ||
          m.embeds?.[0]?.title?.toLowerCase().includes("live event board")
        )
    ) || null;
  }

  const payload = await eventBoardPayload();
  if (!message) message = await channel.send(payload);
  else await message.edit(payload);

  await dbSetState("event_board_message", { messageId: message.id });
  console.log("✅ Live Ashen Event Board ready.");
}

export async function updateEventBoard() {
  const channel = await client.channels.fetch(CHANNELS.EVENT_BOARD).catch(() => null);
  if (!channel?.isTextBased()) return;
  const state = await dbGetState("event_board_message");
  let message = state?.messageId ? await channel.messages.fetch(state.messageId).catch(() => null) : null;
  if (!message) return setupEventBoard();
  await message.edit(await eventBoardPayload()).catch(error => console.error("❌ Event Board update:", error.message));
}
