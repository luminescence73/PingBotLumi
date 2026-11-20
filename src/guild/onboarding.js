import { ONBOARDING_UI } from "../../onboardingLocales.js";
import { PLAYSTYLE, REMINDERS, SOCIAL, TOURNAMENTS } from "../../roleConfig.js";
import { TEXT } from "../../textLocales.js";
import {
  ASHEN_WARRIORS,
  LANGUAGES,
  ONBOARDING_COMPLETE,
  PROTECTED_ROLES,
  RESETTABLE_ROLES
} from "./access.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder
} from "discord.js";
import { brandEmbed } from "../shared/discord.js";
import {
  deleteOnboardingSession,
  getOnboardingSession,
  saveOnboardingSession
} from "../runtime/database.js";
import { savePrimaryLanguage } from "./preferences.js";
import { CHANNELS } from "../../guildConfig.js";
import { upsertRecruitIntroduction } from "./memberCards.js";
import { setupGuildMembersPanel } from "./panels.js";

const ONBOARDING_EVENT_KEYS = ["reset","morning","night","opening","battle","final","registration","chaos_last_call","sever","nexus"];

const ONBOARDING_CHOICE_KEYS = ["none","casual","competitive","both","skip","chatty","quiet","either"];

function onboardingLocale(language) {
  return ONBOARDING_UI[language] || ONBOARDING_UI.english;
}

function localizedOnboardingEvent(language, key) {
  const copy = onboardingLocale(language);
  return copy.events?.[ONBOARDING_EVENT_KEYS.indexOf(key)] ||
    REMINDERS[key]?.name || TOURNAMENTS[key]?.name || key;
}

function localizedOnboardingChoice(language, key) {
  const copy = onboardingLocale(language);
  return copy.choice[ONBOARDING_CHOICE_KEYS.indexOf(key)] || key;
}

function onboardingStageContent(language, stage) {
  const copy = onboardingLocale(language);
  const baseQuestion = stage === 1 ? "" :
    (stage === 2 ? TEXT[language].reminders :
     stage === 3 ? TEXT[language].playstyle : TEXT[language].social);
  return [
    "# " + copy.title[stage - 1], "",
    "**" + copy.step.replace("{n}", String(stage)) + "**", "",
    baseQuestion, baseQuestion ? "" : null,
    copy.note[stage - 1], "", "*" + copy.footer + "*"
  ].filter(part => part !== null).join("\n");
}

function onboardingReviewContent(session) {
  const language = session.language;
  const copy = onboardingLocale(language);
  const info = LANGUAGES[language];
  const reminders = (session.reminders || []).map(key => {
    if (REMINDERS[key]) return REMINDERS[key].emoji + " " + localizedOnboardingEvent(language, key);
    if (key.startsWith("tournament:")) {
      const tournamentKey = key.split(":")[1];
      return TOURNAMENTS[tournamentKey]
        ? TOURNAMENTS[tournamentKey].emoji + " " + localizedOnboardingEvent(language, tournamentKey)
        : key;
    }
    return key;
  });
  const play = session.playstyle ? PLAYSTYLE[session.playstyle] : null;
  const social = session.social ? SOCIAL[session.social] : null;
  return [
    "# " + copy.review[0], "",
    copy.review[1], "",
    "## " + copy.review[2], info.emoji + " **" + info.name + "**", "",
    "## " + copy.review[3], reminders.length ? reminders.join("\n") : copy.review[6], "",
    "## " + copy.review[4], play ? play.emoji + " **" + localizedOnboardingChoice(language, session.playstyle) + "**" : copy.review[7], "",
    "## " + copy.review[5], social ? social.emoji + " **" + localizedOnboardingChoice(language, session.social) + "**" : copy.review[7], "",
    "*" + copy.review[8] + "*"
  ].join("\n");
}

function onboardingCompleteContent(language) {
  const copy = onboardingLocale(language);
  return ["# " + copy.done[0], "", TEXT[language].done, "", copy.done[1], "", copy.done[2]].join("\n");
}

function languageMenu(customId = "onboard_language") {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("🌎 Choose your language")
      .addOptions(Object.entries(LANGUAGES).map(([key, item]) => ({
        label: item.name,
        value: key,
        emoji: item.emoji
      })))
  );
}

function reminderMenu(language) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("onboard_reminders")
      .setPlaceholder(TEXT[language].reminders)
      .setMinValues(1)
      .setMaxValues(Object.keys(REMINDERS).length + Object.keys(TOURNAMENTS).length + 1)
      .addOptions(
        ...Object.entries(REMINDERS).map(([key, item]) => ({
          label: localizedOnboardingEvent(language, key),
          value: key,
          emoji: item.emoji
        })),
        ...Object.entries(TOURNAMENTS).map(([key, item]) => ({
          label: localizedOnboardingEvent(language, key) + onboardingLocale(language).suffix,
          value: `tournament:${key}`,
          emoji: item.emoji
        })),
        { label: localizedOnboardingChoice(language, "none"), value: "none", emoji: "🔕" }
      )
  );
}

function playstyleMenu(language) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("onboard_playstyle")
      .setPlaceholder(TEXT[language].playstyle)
      .addOptions(
        { label: localizedOnboardingChoice(language, "casual"), value: "casual", emoji: "🌿" },
        { label: localizedOnboardingChoice(language, "competitive"), value: "competitive", emoji: "⚔️" },
        { label: localizedOnboardingChoice(language, "both"), value: "both", emoji: "🎮" },
        { label: localizedOnboardingChoice(language, "skip"), value: "skip", emoji: "⏭️" }
      )
  );
}

function socialMenu(language) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("onboard_social")
      .setPlaceholder(TEXT[language].social)
      .addOptions(
        { label: localizedOnboardingChoice(language, "chatty"), value: "chatty", emoji: "💬" },
        { label: localizedOnboardingChoice(language, "quiet"), value: "quiet", emoji: "🌙" },
        { label: localizedOnboardingChoice(language, "either"), value: "either", emoji: "✨" },
        { label: localizedOnboardingChoice(language, "skip"), value: "skip", emoji: "⏭️" }
      )
  );
}

function finishButton(language) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("onboard_finish")
      .setLabel(TEXT[language].finish)

      .setStyle(ButtonStyle.Success)
  );
}

function newSession(language = null) {
  return { language, reminders: [], playstyle: null, social: null };
}

function showStep(interaction, content, component) {
  return interaction.editReply({ content, embeds: [], components: [component] });
}

function onboardingUnavailable(interaction, title, description) {
  return interaction.editReply({ embeds: [brandEmbed(title, description)], components: [] });
}

async function updateOnboardingChoice(interaction, update, next, missingMessage) {
  await interaction.deferUpdate();
  const userId = interaction.user.id;
  const session = await getOnboardingSession(userId);
  if (!session?.language) {
    return onboardingUnavailable(interaction, "⚠️ Onboarding Session Missing", missingMessage);
  }

  update(session, interaction.values);
  await saveOnboardingSession(userId, session);
  return next(session);
}

export async function startOnboarding(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await saveOnboardingSession(interaction.user.id, newSession());
  return showStep(interaction, onboardingStageContent("english", 1), languageMenu());
}

export async function onboardLanguage(interaction) {
  await interaction.deferUpdate();
  const [language] = interaction.values;
  await saveOnboardingSession(interaction.user.id, newSession(language));
  return showStep(interaction, onboardingStageContent(language, 2), reminderMenu(language));
}

export function onboardReminders(interaction) {
  return updateOnboardingChoice(
    interaction,
    (session, values) => { session.reminders = values.includes("none") ? [] : values; },
    ({ language }) => showStep(interaction, onboardingStageContent(language, 3), playstyleMenu(language)),
    "Your onboarding session could not be found. Press **Start Onboarding** again and Vestra will restart it for you."
  );
}

const RESTART_MESSAGE = "Press **Start Onboarding** again to restart your setup.";

export function onboardPlaystyle(interaction) {
  return updateOnboardingChoice(
    interaction,
    (session, [value]) => { session.playstyle = value === "skip" ? null : value; },
    ({ language }) => showStep(interaction, onboardingStageContent(language, 4), socialMenu(language)),
    RESTART_MESSAGE
  );
}

export function onboardSocial(interaction) {
  return updateOnboardingChoice(
    interaction,
    (session, [value]) => { session.social = value === "skip" ? null : value; },
    session => showStep(interaction, onboardingReviewContent(session), finishButton(session.language)),
    RESTART_MESSAGE
  );
}

export async function onboardFinish(interaction) {
  await interaction.deferUpdate();
  const session = await getOnboardingSession(interaction.user.id);
  if (!session?.language) {
    return onboardingUnavailable(
      interaction,
      "⚠️ Onboarding Needs to Restart",
      "Vestra couldn’t recover your language selection. Press **Start Onboarding** again — your progress is now saved in the database during future restarts."
    );
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const language = LANGUAGES[session.language];
  const playstyle = PLAYSTYLE[session.playstyle];
  const social = SOCIAL[session.social];
  const chosenRoles = new Set([ASHEN_WARRIORS, language.role, ONBOARDING_COMPLETE]);
  for (const key of session.reminders || []) {
    const role = REMINDERS[key] || (key.startsWith("tournament:") ? TOURNAMENTS[key.split(":")[1]] : null);
    if (role) chosenRoles.add(role.role);
  }
  if (playstyle) chosenRoles.add(playstyle.role);
  if (social) chosenRoles.add(social.role);

  const rolesToRemove = [...RESETTABLE_ROLES].filter(roleId =>
    !chosenRoles.has(roleId) && !PROTECTED_ROLES.has(roleId) && member.roles.cache.has(roleId)
  );
  const rolesToAdd = [...chosenRoles].filter(roleId => !member.roles.cache.has(roleId));
  if (rolesToRemove.length) await member.roles.remove(rolesToRemove);
  if (rolesToAdd.length) await member.roles.add(rolesToAdd);

  await savePrimaryLanguage(member.id, session.language);
  const intro = await interaction.guild.channels.fetch(CHANNELS.INTRODUCTIONS).catch(() => null);
  if (intro?.isTextBased()) {
    await upsertRecruitIntroduction(
      intro,
      member,
      language.name,
      playstyle?.name || "Not specified",
      social?.name || "Not specified"
    );
  }

  await deleteOnboardingSession(interaction.user.id);
  await setupGuildMembersPanel().catch(() => {});
  return interaction.editReply({
    content: onboardingCompleteContent(session.language),
    embeds: [],
    components: []
  });
}
