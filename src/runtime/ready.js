import { runDiagnostics } from './diagnostics.js';
import { client } from "./client.js";
import { Events } from "discord.js";
import { BOT_NAME } from "../shared/discord.js";
import { initDatabase, pool } from "./database.js";
import { startKeywordHistoryScan } from "../community/keywordAlerts.js";
import { cleanupLegacySocialCompanions } from "../translation/social.js";
import {
  cleanupLegacyWelcomePanels,
  setupBotLogsPanel,
  setupGuildMembersPanel,
  setupGuildPingsPanel,
  setupHelpCenter,
  setupIntroductionPanel,
  setupMemberGuildPingsPanel,
  setupOnboardingPanel,
  setupPreferences,
  setupRulesPanel,
  setupStaffChatPanel,
  setupStaffRequestsPanel,
  setupStartHere,
  setupSuggestionsPanel
} from "../guild/panels.js";
import { refreshAshenSidebarReferences, resolveAshenGuild } from "../guild/access.js";
import { cleanupDuplicateSidebarChannels } from "../guild/sidebar.js";
import { applyAshenPermissions, runPermissionChecks } from "../guild/permissions.js";
import { enforceAshenMembersStaffOnly } from "../guild/showcase.js";
import {
  backfillRecentGuildPingRecords,
  cleanOldNightConquestStaffEntry,
  migrateLegacyAlertHistory,
  spaceExistingGuildPingRecords,
  updateStaffPingDashboard
} from "../events/pingLog.js";
import { setupEventBoard } from "../events/tournaments.js";
import { setupConquestIntel } from "../../conquestIntel.js";
import { setupSxsHub } from "../../sxsHub.js";
import { CHANNELS } from "../../guildConfig.js";
import { STAFF_ROLES } from "../../roleConfig.js";
import { startScheduler } from "../events/scheduler.js";
import { startTranslationHealthMonitor } from "../translation/health.js";
import { migrateLegacyIntroductions } from "../guild/memberCards.js";

client.once(Events.ClientReady, onReady);

async function onReady(readyClient) {
  console.log(`✅ ${BOT_NAME} online as ${readyClient.user.tag}`);

  try {
    await initDatabase();
  } catch (error) {
    console.error("❌ DATABASE FAILED TO INITIALIZE:", error);
    return;
  }

  // Start keyword monitoring as soon as its database is ready.
  startKeywordHistoryScan();
  console.log("🔎 Keyword monitoring scheduled immediately after database initialization.");

  await cleanupLegacySocialCompanions().catch(error => {
    console.error("⚠️ Legacy social translation cleanup:", error.message);
  });

  await cleanupLegacyWelcomePanels().catch(error => {
    console.error("⚠️ Legacy panel cleanup:", error.message);
  });

  const ashenGuild = await resolveAshenGuild().catch(() => null);

  await refreshAshenSidebarReferences(ashenGuild).catch(error => {
    console.error("⚠️ Ashen sidebar read-only check:", error.message);
  });

  await cleanupDuplicateSidebarChannels(ashenGuild).catch(error => {
    console.error("❌ Duplicate sidebar cleanup:", error);
  });

  await applyAshenPermissions(ashenGuild).catch(error => {
    console.error("⚠️ Ashen permission model:", error.message);
  });

  // Channel/category names are now controlled manually by Ashen staff.
  // Never reapply the sidebar theme or rename channels at bot startup.

  await enforceAshenMembersStaffOnly(ashenGuild).catch(error => {
    console.error("❌ Could not enforce staff-only showcase posting:", error);
  });

  const setupTasks = [
    ["Start Here", setupStartHere],
    ["Rules Guide", setupRulesPanel],
    ["Onboarding", setupOnboardingPanel],
    ["Help Center", setupHelpCenter],
    ["Preferences", setupPreferences],
    ["Introductions", setupIntroductionPanel],
    ["Staff Requests", setupStaffRequestsPanel],
    ["Guild Members", setupGuildMembersPanel],
    ["Staff Chat", setupStaffChatPanel],
    ["Suggestions", setupSuggestionsPanel],
    ["Bot Logs", setupBotLogsPanel],
    ["Member Guild Pings", setupMemberGuildPingsPanel],
    ["Guild Ping Log", setupGuildPingsPanel],
    ["Staff Ping Monitor", updateStaffPingDashboard],
    ["Live Event Board", setupEventBoard],
    ["Conquest Intel", () => setupConquestIntel({ client, pool, guild: ashenGuild })],
    ["Sword x Staff Live Hub", () => setupSxsHub({
      client,
      remindersChannelId: CHANNELS.REMINDERS,
      staffRoles: STAFF_ROLES
    })]
  ];

  for (const [label, fn] of setupTasks) {
    try {
      await fn();
      console.log(`✅ ${label} ready.`);
    } catch (error) {
      console.error(`❌ ${label} setup error:`, error);
    }
  }

  try {
    await runPermissionChecks();
  } catch (error) {
    console.error("❌ Permission audit error:", error);
  }

  void runDiagnostics(readyClient, ashenGuild, pool).catch(error => console.error('Vestra diagnostics failed:', error.message));
  startScheduler();
  startTranslationHealthMonitor();
  void cleanOldNightConquestStaffEntry().catch(error =>
    console.error("❌ Old Night Conquest staff log cleanup:", error)
  );

  // Safe one-time migrations of Vestra's older generated messages.
  void migrateLegacyIntroductions().catch(error => {
    console.error("❌ Could not complete introductions rebuild v4:", error);
  });

  void migrateLegacyAlertHistory()
    .catch(error => console.error("❌ Could not complete old guild-ping-log conversion:", error))
    .then(() => backfillRecentGuildPingRecords())
    .then(() => spaceExistingGuildPingRecords())
    .catch(error => console.error("❌ Could not sync and space recent guild ping records:", error));

  // Historical thread renaming is intentionally disabled. Staff have
  // manually curated existing titles, and restarts must never replace them.
  // New staff showcase posts still receive an immediate discussion thread.

  console.log("✅ Google Cloud Translation active.");
  console.log("✅ Persistent edit/delete/reaction sync active.");
  console.log("✅ Synced reply links active across translated channels.");
  console.log("✅ 🌐 reaction translations active across Social, Important, Welcome, SxS Media, and SxS Resources.");
  console.log("✅ Primary-language notification delivery active.");
  console.log("✅ Server + Nexus Tournament Mode active with manual voting rounds.");
  console.log("✅ Community Highlights active.");
}
