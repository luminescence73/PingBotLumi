import { client } from "../runtime/client.js";
import { dbGetState, dbSetState } from "../runtime/database.js";
import { CHANNELS } from "../../guildConfig.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";
import { LANGUAGES, ONBOARDING_COMPLETE, getGuild, isStaff } from "./access.js";
import { PLAYSTYLE, REMINDERS, SOCIAL, TOURNAMENTS } from "../../roleConfig.js";
import { getMemberGuildPingsChannel, sidebarChannelGroup, staffChatKeeperId } from "./sidebar.js";
import { getGuildMembersDirectoryChannel } from "./showcase.js";

export async function upsertBotPanel(channelOrId, stateKey, payload, footerTag) {
  const channel = typeof channelOrId === "string"
    ? await client.channels.fetch(channelOrId).catch(() => null)
    : channelOrId;

  if (!channel?.isTextBased()) return null;

  const saved = await dbGetState(stateKey).catch(() => null);
  let message = saved?.messageId
    ? await channel.messages.fetch(saved.messageId).catch(() => null)
    : null;

  if (!message && footerTag) {
    const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    message = recent?.find(
      m =>
        m.author.id === client.user.id &&
        (
          m.content?.includes(footerTag) ||
          m.embeds?.some(embed => embed.footer?.text === footerTag)
        )
    ) || null;
  }

  if (message) {
    await message.edit(payload);
  } else {
    message = await channel.send(payload);
  }

  await dbSetState(stateKey, { messageId: message.id });
  return message;
}

export async function cleanupLegacyWelcomePanels() {
  const channelIds = [
    CHANNELS.START_HERE,
    CHANNELS.ONBOARDING,
    CHANNELS.HELP,
    CHANNELS.PREFERENCES
  ];

  const marker =
    /(ASHEN|VESTRA)_(START_HERE|ONBOARDING_PANEL|HELP_CENTER|LANG_PREF|REMINDER_PREF|PLAYSTYLE_PREF|SOCIAL_PREF|SETTINGS_PANEL|TOURNAMENT_PREF)/;

  let removed = 0;

  for (const channelId of channelIds) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) continue;

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages) continue;

    for (const message of messages.values()) {
      if (
        message.author.id === client.user.id &&
        marker.test(message.content || "")
      ) {
        await message.delete().catch(() => {});
        removed++;
      }
    }
  }

  if (removed) {
    console.log(`🧹 Removed ${removed} legacy Vestra panel message(s).`);
  }
}

export async function setupStartHere() {
  const content = `# ASHEN WARRIORS
**ENTRY PROTOCOL**

Ashen is built on discipline, loyalty, and a strong guild. Set up your access before entering the server.

## 01 / CODE
Read <#${CHANNELS.RULES}>. Respect the guild, protect its members, and keep disputes out of public channels.

## 02 / INDUCTION
Open <#${CHANNELS.ONBOARDING}> and select **Begin Induction**. Choose your language, alerts, playstyle, and social preference.

## 03 / CONFIGURATION
Change your settings at any time in <#${CHANNELS.PREFERENCES}>.

## 04 / SUPPORT
Use <#${CHANNELS.HELP}> for strategy, teams, technical help, or private staff requests.

## 05 / ROSTER
After induction, Vestra introduces you in <#${CHANNELS.INTRODUCTIONS}>.

## COMMUNICATION
General channels support automatic translation. In other supported channels, use the globe reaction to translate a message.

## ALERTS
Choose guild and tournament alerts. Only your selected reminders will notify you.

**Enter prepared. Stand with Ashen.**`;

  await upsertBotPanel(
    CHANNELS.START_HERE, "panel_start_here",
    { content, embeds: [], components: [] },
    "# ASHEN WARRIORS"
  );
}

export async function setupRulesPanel() {
  const content = `# THE ASHEN CODE
**Standards of conduct**

## RESPECT
Treat members with respect. Banter is welcome; harassment and targeted hostility are not.

## SECURITY
No scams, malicious links, stolen accounts, cheats, or disclosure of private guild information.

## DISCIPLINE
Keep channels on topic, handle disputes responsibly, and follow staff direction when intervention is required.

## DUTY
Support the guild when you can. Communicate when plans change. Real life takes priority.

## ACCOUNTABILITY
Minor issues may receive a warning. Repeated or serious violations may lead to staff action.

**Strength without discipline is nothing.**`;

  await upsertBotPanel(
    CHANNELS.RULES, "panel_rules_guide",
    { content, embeds: [], components: [] },
    "# THE ASHEN CODE"
  );
}

export async function setupOnboardingPanel() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("start_onboarding")
      .setLabel("Begin Induction")
      .setStyle(ButtonStyle.Primary)
  );

  const content = `# ASHEN / INDUCTION
**Complete four steps to gain access.**

**01 — Language**
Select your primary language for notifications and translation.

**02 — Alerts**
Select guild reminders and Server/Nexus Tournament alerts.

**03 — Playstyle**
Casual, Competitive, or Both.

**04 — Social**
Chatty, Quiet, or Either.

Vestra assigns your roles and unlocks the server when induction is complete. Change your choices later in Settings.`;

  await upsertBotPanel(
    CHANNELS.ONBOARDING, "panel_onboarding",
    { content, embeds: [], components: [row] },
    "# ASHEN / INDUCTION"
  );
}

export const preferenceMessages = {
  languages: null,
  reminders: null,
  tournaments: null,
  playstyle: null,
  social: null
};

async function createPreferencePanel(channel, stateKey, content, emojis, anchor) {
  const message = await upsertBotPanel(
    channel,
    stateKey,
    { content, embeds: [], components: [] },
    anchor
  );

  if (!message) return null;

  for (const emoji of emojis) {
    try {
      const already = message.reactions.cache.some(
        reaction => reaction.emoji.name === emoji
      );

      if (!already) {
        await message.react(emoji);
      }
    } catch (error) {
      console.error(`❌ Reaction ${emoji} failed:`, error.message);
    }
  }

  return message;
}

export async function setupPreferences() {
  const channel = await client.channels.fetch(CHANNELS.PREFERENCES);
  if (!channel?.isTextBased()) return;

  // Reaction icons are functional selectors. Panel text stays minimal.
  preferenceMessages.languages = await createPreferencePanel(
    channel, "panel_pref_languages",
    `# LANGUAGE ACCESS
Select the language channels you want by using the reactions below.

English · Spanish · French · German · Portuguese · Japanese

Primary notification language is set separately in Settings.`,
    Object.values(LANGUAGES).map(x => x.emoji),
    "# LANGUAGE ACCESS"
  );

  preferenceMessages.reminders = await createPreferencePanel(
    channel, "panel_pref_reminders",
    `# GUILD ALERTS
Select each alert using the matching reaction below. Vestra sends notifications in your selected General language.

${Object.values(REMINDERS).map(item => item.emoji + "  " + item.name).join("\n")}

Only subscribed alerts will notify you.`,
    Object.values(REMINDERS).map(x => x.emoji),
    "# GUILD ALERTS"
  );

  // Retire the previous Chaos emoji on an existing reaction-role panel.
  // This only cleans up the obsolete UI reaction; current role subscriptions stay intact.
  const oldChaosReaction = preferenceMessages.reminders?.reactions.cache.find(
    reaction => reaction.emoji.name === "☄️"
  );
  if (oldChaosReaction) {
    await oldChaosReaction.remove().catch(error =>
      console.warn("Could not clear previous Chaos reaction:", error.message)
    );
  }

  preferenceMessages.tournaments = await createPreferencePanel(
    channel, "panel_pref_tournaments",
    `# TOURNAMENT ALERTS
Subscribe to Server Tournament, Nexus Tournament, or both.

**Server Tournament** — Saturdays, 2 PM Standard / 3 PM DST
**Nexus Tournament** — alternating Sundays, 3 PM Standard / 4 PM DST

Staff opens voting rounds when each battle is ready.`,
    Object.values(TOURNAMENTS).map(x => x.emoji),
    "# TOURNAMENT ALERTS"
  );

  preferenceMessages.playstyle = await createPreferencePanel(
    channel, "panel_pref_playstyle",
    `# PLAYSTYLE
Select Casual, Competitive, or Both using the reactions below.`,
    Object.values(PLAYSTYLE).map(x => x.emoji),
    "# PLAYSTYLE"
  );

  preferenceMessages.social = await createPreferencePanel(
    channel, "panel_pref_social",
    `# SOCIAL
Select Chatty, Quiet, or Either using the reactions below.`,
    Object.values(SOCIAL).map(x => x.emoji),
    "# SOCIAL"
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("settings_open")
      .setLabel("Open Settings").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("settings_card")
      .setLabel("View Profile").setStyle(ButtonStyle.Secondary)
  );

  const settingsContent = `# VESTRA / SETTINGS
Control your language access, notification language, reminders, tournament alerts, playstyle, and social preference.

Use the reactions above for quick changes or open Settings to manage everything in one place.`;

  await upsertBotPanel(
    channel, "panel_pref_settings",
    { content: settingsContent, embeds: [], components: [row] },
    "# VESTRA / SETTINGS"
  );
}

export async function setupHelpCenter() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("help_game").setLabel("Game Support").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("help_team").setLabel("Find a Team").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("help_staff").setLabel("Contact Staff").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("help_discord").setLabel("Discord Support").setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("help_faq").setLabel("FAQ").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("help_guide").setLabel("Server Guide").setStyle(ButtonStyle.Secondary)
  );

  const content = `# ASHEN / SUPPORT
**Select a route below.**

**GAME SUPPORT** — Builds, mechanics, and strategy.
**FIND A TEAM** — Form a squad for guild content.
**CONTACT STAFF** — Private request to leadership.
**DISCORD SUPPORT** — Technical or server issues.
**FAQ / SERVER GUIDE** — Common questions and navigation.

Staff requests are handled privately.`;

  await upsertBotPanel(
    CHANNELS.HELP, "panel_help_center",
    { content, embeds: [], components: [row1, row2] },
    "# ASHEN / SUPPORT"
  );
}

export async function setupMemberGuildPingsPanel() {
  const channel = await getMemberGuildPingsChannel();
  if (!channel) {
    console.warn("⚠️ Member guild-pings room is missing; no new room will be created.");
    return;
  }

  const content = `# ASHEN / GUILD PINGS
Official guild and tournament alerts are mirrored here for the whole guild.

**NOTIFICATIONS**
Members who subscribe receive one translated notification in their chosen language's General channel. This feed does not send additional pings.

Change your event subscriptions in <#${CHANNELS.PREFERENCES}>.`;

  await upsertBotPanel(
    channel, "panel_member_guild_pings",
    { content, embeds: [], components: [] },
    "# ASHEN / GUILD PINGS"
  );
}

export async function setupGuildPingsPanel() {
  const content = [
    "# ASHEN / STAFF GUILD PING LOG",
    "**Private staff operations feed.**",
    "",
    "Public event archives continue in the member Guild Pings channel without extra mentions.",
    "",
    "**STAFF OPERATIONS**",
    "Vestra tracks successful localized deliveries, failures, translation fallbacks,",
    "blocked duplicate requests, manual actions, subscription changes, and missed reminders.",
    "",
    "The pinned staff monitoring panel updates automatically. No diagnostics or",
    "private staff activity are mirrored into the member-facing feed."
  ].join("\n");
  await upsertBotPanel(
    CHANNELS.REMINDERS, "panel_guild_pings",
    { content, embeds: [], components: [] },
    "# ASHEN / STAFF GUILD PING LOG"
  );
}

export async function setupIntroductionPanel() {
  // The introductions channel is rebuilt in one controlled pass after startup
  // so the guide can be physically first and duplicate recruit cards removed.
  return true;
}

export async function setupStaffRequestsPanel() {
  const content = `# ASHEN / STAFF REQUESTS
**Staff access only.**

Private support requests appear here with the member, submission time, details, and status.

Keep all member information confidential. Vestra notifies leadership when a new request arrives.`;

  await upsertBotPanel(
    CHANNELS.STAFF_REQUESTS, "panel_staff_requests",
    { content, embeds: [], components: [] },
    "# ASHEN / STAFF REQUESTS"
  );
}

export async function setupGuildMembersPanel() {
  const guild = getGuild();
  if (!guild) return;
  const channel = getGuildMembersDirectoryChannel(guild);
  if (!channel) return;

  await guild.members.fetch().catch(() => {});
  const humanMembers = guild.members.cache.filter(member => !member.user.bot);
  const staffCount = humanMembers.filter(member => isStaff(member)).size;
  const onboardedCount = humanMembers.filter(
    member => member.roles.cache.has(ONBOARDING_COMPLETE)
  ).size;

  const content = `# ASHEN / GUILD MEMBERS
**Private staff directory.**

**CURRENT ROSTER**
${humanMembers.size} members · ${staffCount} staff · ${onboardedCount} inducted

Use this channel for staff-side member reference and Vestra profile access. Community showcase posts remain in #community-highlights.`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("settings_card")
      .setLabel("View Profile").setStyle(ButtonStyle.Primary)
  );

  await upsertBotPanel(
    channel, "panel_guild_members",
    { content, embeds: [], components: [row] },
    "# ASHEN / GUILD MEMBERS"
  );
}

export async function setupStaffChatPanel() {
  const guild = getGuild();
  const channel = staffChatKeeperId
    ? guild?.channels?.cache?.get(staffChatKeeperId)
    : (guild ? sidebarChannelGroup(guild, "staff-chat", "ashencommand")[0] : null);
  if (!channel) return;

  await upsertBotPanel(
    channel,
    "panel_staff_chat",
    {
      content: `# ASHEN / STAFF CHAT
**This channel is private to Ashen staff.**

Use this space for conversations that belong behind the scenes rather than in public guild channels.

**Good things to discuss here**
• Guild decisions and upcoming plans
• Event, tournament, and Conquest coordination
• Member concerns or situations staff should be aware of
• Moderation questions and second opinions
• Coverage, reminders, and staff responsibilities
• Vestra or Discord changes before they go live
• SxS strategy or guild organization that needs staff input
• Anything the staff team needs to talk through privately

Keep member information confidential and only share what staff actually needs to know.\n\n**Vestra build:** Intro Sync v4`,
      embeds: [],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("admin_sync_introductions")
            .setLabel("Sync Introductions")
            .setEmoji("🔄")
            .setStyle(ButtonStyle.Primary)
        )
      ]
    },
    "# ASHEN / STAFF CHAT"
  );
}

export async function setupSuggestionsPanel() {
  const guild = getGuild();
  const channel = guild?.channels?.cache?.find(
    ch => ch.type === ChannelType.GuildText && ch.name === "suggestions"
  );
  if (!channel) return;

  await upsertBotPanel(
    channel,
    "panel_suggestions",
    {
      content: `# ASHEN / SUGGESTIONS
Share ideas that could improve Ashen Warriors, Vestra, events, resources, or the server itself.

Keep suggestions specific and constructive so staff can review them easily.`,
      embeds: [],
      components: []
    },
    "# ASHEN / SUGGESTIONS"
  );
}

export async function setupBotLogsPanel() {
  const guild = getGuild();
  const channel = guild?.channels?.cache?.find(
    ch => ch.type === ChannelType.GuildText && ch.name === "bot-logs"
  );
  if (!channel) return;

  const started = Math.floor(Date.now() / 1000);
  await upsertBotPanel(
    channel,
    "panel_bot_logs",
    {
      content: `# VESTRA / BOT LOGS
**Operational status**

Vestra completed startup at <t:${started}:F>.

Use this private channel for Vestra deployment notes, troubleshooting, and operational checks.`,
      embeds: [],
      components: []
    },
    "# VESTRA / BOT LOGS"
  );
}
