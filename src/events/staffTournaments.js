import { isStaff } from "../guild/access.js";
import { MessageFlags } from "discord.js";
import { finishTournament, getActiveTournamentState, startTournamentVote } from "./tournaments.js";
import { TOURNAMENTS } from "../../roleConfig.js";

export async function tournamentNext(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!isStaff(member)) return interaction.reply({ content: "❌ Only Ashen staff can advance tournament rounds.", flags: MessageFlags.Ephemeral });
  const state = await getActiveTournamentState();
  if (!state || state.phase !== "battle") return interaction.reply({ content: "❌ There isn't a battle waiting for the next vote right now.", flags: MessageFlags.Ephemeral });
  const tournament = TOURNAMENTS[state.tournament];
  if (state.round >= tournament.rounds) return interaction.reply({ content: "Round 4 is already complete. Use Finish Tournament after the final battle.", flags: MessageFlags.Ephemeral });
  await startTournamentVote(state.tournament, state.round + 1, true, interaction.user.id);
  return interaction.reply({ content: `✅ Round ${state.round + 1} voting opened.`, flags: MessageFlags.Ephemeral });
}

export async function tournamentFinish(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!isStaff(member)) return interaction.reply({ content: "❌ Only Ashen staff can finish Tournament Mode.", flags: MessageFlags.Ephemeral });
  const state = await getActiveTournamentState();
  if (!state) return interaction.reply({ content: "❌ No active tournament.", flags: MessageFlags.Ephemeral });
  await finishTournament(state.tournament);
  return interaction.reply({ content: "Tournament closed. The War Board has returned to the standard schedule.", flags: MessageFlags.Ephemeral });
}
