import {

  Client,

  GatewayIntentBits,

  Partials,

  ActionRowBuilder,

  ButtonBuilder,

  ButtonStyle,

  StringSelectMenuBuilder,

  Events

} from "discord.js";

import cron from "node-cron";

// ======================================================

// DISCORD CLIENT

// ======================================================

const client = new Client({

  intents: [

    GatewayIntentBits.Guilds,

    GatewayIntentBits.GuildMembers,

    GatewayIntentBits.GuildMessages,

    GatewayIntentBits.GuildMessageReactions

  ],

  partials: [

    Partials.Message,

    Partials.Channel,

    Partials.Reaction

  ]

});

// ======================================================

// SERVER SETTINGS

// ======================================================

// Your existing reminder channel

const REMINDER_CHANNEL_ID = "1537611487768744046";

// Welcome / onboarding channels

const CHANNELS = {

  START_HERE: "1540332552584167444",

  RULES: "1540332590891008093",

  ONBOARDING: "1540332651980787743",

  HELP: "1540332685216452610",

  INTRODUCTIONS: "1540407351469940888",

  PREFERENCES: "1540407411326591137"

};

// Language channels - used later for translation

const LANGUAGE_CHANNELS = {

  english: "1507565773336481966",

  spanish: "1540387246752931900",

  french: "1540387342408351924",

  german: "1540387464542167202",

  portuguese: "1540387524709589002",

  japanese: "1540387566480531537"

};

// ======================================================

// PROTECTED STAFF ROLES

// THESE WILL NEVER BE REMOVED BY ONBOARDING

// ======================================================

const PROTECTED_ROLE_IDS = new Set([

  "1507567387774423171", // Owner

  "1507567296447516714", // Admin

  "1507567404836847747", // Deputy

  "1507567452391870544"  // Officers

]);

// ======================================================

// CORE ROLES

// ======================================================

const ASHEN_WARRIORS_ROLE = "1507567323161038899";

const ONBOARDING_COMPLETE_ROLE = "1540336639635628032";

// ======================================================

// LANGUAGE ROLES

// ======================================================

const LANGUAGE_ROLES = {

  english: {

    name: "English",

    emoji: "🇺🇸",

    roleId: "1540336707520434176"

  },

  spanish: {

    name: "Spanish",

    emoji: "🇪🇸",

    roleId: "1540336749866131476"

  },

  french: {

    name: "French",

    emoji: "🇫🇷",

    roleId: "1540337010609365073"

  },

  german: {

    name: "German",

    emoji: "🇩🇪",

    roleId: "1540337119493357668"

  },

  portuguese: {

    name: "Portuguese",

    emoji: "🇵🇹",

    roleId: "1540337336087482501"

  },

  japanese: {

    name: "Japanese",

    emoji: "🇯🇵",

    roleId: "1540337389900271676"

  }

};

// ======================================================

// PLAYSTYLE ROLES

// ======================================================

const PLAYSTYLE_ROLES = {

  casual: {

    name: "Casual",

    emoji: "🌿",

    roleId: "1540337903497117736"

  },

  competitive: {

    name: "Competitive",

    emoji: "⚔️",

    roleId: "1540337984459513877"

  },

  both: {

    name: "Both",

    emoji: "🎮",

    roleId: "1540338047189655552"

  }

};

// ======================================================

// SOCIAL ROLES

// ======================================================

const SOCIAL_ROLES = {

  chatty: {

    name: "Chatty",

    emoji: "💬",

    roleId: "1540338102244216902"

  },

  quiet: {

    name: "Quiet",

    emoji: "🌙",

    roleId: "1540338180291694604"

  },

  either: {

    name: "Either",

    emoji: "✨",

    roleId: "1540338259761176606"

  }

};

// ======================================================

// REMINDER ROLES

// ======================================================

const REMINDER_ROLES = {

  reset: {

    name: "Reset",

    emoji: "🔄",

    roleId: "1537936033273086073"

  },

  morningConquest: {

    name: "Morning Conquest",

    emoji: "🌅",

    roleId: "1537936135114854430"

  },

  nightConquest: {

    name: "Night Conquest",

    emoji: "🌌",

    roleId: "1537936185979183194"

  },

  clashOpening: {

    name: "Clash Opening Call",

    emoji: "🔔",

    roleId: "1537936269043310752"

  },

  clashBattle: {

    name: "Clash Battle Call",

    emoji: "⚔️",

    roleId: "1537936402497675265"

  },

  clashFinal: {

    name: "Clash Final Call",

    emoji: "🚨",

    roleId: "1537936646442451075"

  },

  clashRegistration: {

    name: "Guild Clash Registration",

    emoji: "⏰",

    roleId: "1537936738998296618"

  }

};

// ======================================================

// ALL BOT-CONTROLLED PREFERENCE ROLES

// ======================================================

const ALL_PREFERENCE_ROLE_IDS = new Set([

  ...Object.values(LANGUAGE_ROLES).map(x => x.roleId),

  ...Object.values(PLAYSTYLE_ROLES).map(x => x.roleId),

  ...Object.values(SOCIAL_ROLES).map(x => x.roleId),

  ...Object.values(REMINDER_ROLES).map(x => x.roleId)

]);

// ======================================================

// ONBOARDING TRANSLATIONS

// ======================================================

const TEXT = {

  english: {

    welcome: "Welcome to Ashen Warriors!",

    languageChosen: "Your onboarding language is now English.",

    reminders: "Which reminders would you like to receive?",

    playstyle: "How would you describe your playstyle?",

    social: "How social are you usually?",

    finish: "Finish Onboarding",

    completed: "Your onboarding is complete! Welcome to Ashen Warriors.",

    selectReminders: "Choose all reminder pings you want.",

// trigger Railway deploy

   