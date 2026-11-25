import { handleSocialTranslationButton } from "../translation/social.js";
import { staffPingRefresh } from "../events/pingLog.js";
import { adminApplyTheme, adminSyncIntroductions } from "../guild/admin.js";
import {
  helpDiscord,
  helpFaq,
  helpGame,
  helpGuide,
  helpStaff,
  helpTeam,
  modalDiscordHelp,
  modalGameHelp,
  modalStaffHelp,
  modalTeamHelp
} from "../guild/help.js";
import {
  onboardFinish,
  onboardLanguage,
  onboardPlaystyle,
  onboardReminders,
  onboardSocial,
  startOnboarding
} from "../guild/onboarding.js";
import {
  settingsBack,
  settingsCard,
  settingsLanguages,
  settingsLanguagesSelect,
  settingsNotify,
  settingsNotifySelect,
  settingsOpen,
  settingsPlaystyle,
  settingsPlaystyleSelect,
  settingsReminders,
  settingsRemindersSelect,
  settingsSocial,
  settingsSocialSelect,
  settingsTournaments,
  settingsTournamentsSelect
} from "../guild/settings.js";
import { conquestSecondRun, conquestSecondRunSelect } from "../events/staffConquest.js";
import { tournamentFinish, tournamentNext } from "../events/staffTournaments.js";
import { client } from "./client.js";
import { Events, MessageFlags } from "discord.js";
import { handleConquestIntelInteraction } from "../../conquestIntel.js";
import { pool } from "./database.js";
import { isStaff } from "../guild/access.js";

const buttons = new Map(Object.entries({
  staff_ping_refresh: staffPingRefresh,
  admin_apply_theme: adminApplyTheme,
  admin_sync_introductions: adminSyncIntroductions,
  help_game: helpGame,
  help_team: helpTeam,
  help_staff: helpStaff,
  help_discord: helpDiscord,
  help_faq: helpFaq,
  help_guide: helpGuide,
  start_onboarding: startOnboarding,
  onboard_finish: onboardFinish,
  settings_open: settingsOpen,
  settings_back: settingsBack,
  settings_card: settingsCard,
  settings_languages: settingsLanguages,
  settings_notify: settingsNotify,
  settings_reminders: settingsReminders,
  settings_tournaments: settingsTournaments,
  settings_playstyle: settingsPlaystyle,
  settings_social: settingsSocial,
  conquest_second_run: conquestSecondRun,
  tournament_next: tournamentNext,
  tournament_finish: tournamentFinish
}));

const modals = new Map(Object.entries({
  modal_game_help: modalGameHelp,
  modal_team_help: modalTeamHelp,
  modal_discord_help: modalDiscordHelp,
  modal_staff_help: modalStaffHelp
}));

const selectMenus = new Map(Object.entries({
  onboard_language: onboardLanguage,
  onboard_reminders: onboardReminders,
  onboard_playstyle: onboardPlaystyle,
  onboard_social: onboardSocial,
  settings_languages_select: settingsLanguagesSelect,
  settings_notify_select: settingsNotifySelect,
  settings_reminders_select: settingsRemindersSelect,
  settings_tournaments_select: settingsTournamentsSelect,
  settings_playstyle_select: settingsPlaystyleSelect,
  settings_social_select: settingsSocialSelect,
  conquest_second_run_select: conquestSecondRunSelect
}));

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (await handleSocialTranslationButton(interaction)) return;
    if (await handleConquestIntelInteraction(interaction, { client, pool, isStaff })) return;

    const routes = interaction.isButton() ? buttons
      : interaction.isStringSelectMenu() ? selectMenus
      : interaction.isModalSubmit() ? modals : null;
    await routes?.get(interaction.customId)?.(interaction);
  } catch (error) {
    console.error("❌ Interaction error:", error);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "❌ Something went wrong. Please try again.", flags: MessageFlags.Ephemeral });
      } else if (interaction.isRepliable() && interaction.deferred) {
        await interaction.editReply("❌ Something went wrong. Please try again.");
      }
    } catch {}
  }
});
