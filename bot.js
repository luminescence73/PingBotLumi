import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType
} from "discord.js";
import pg from "pg";
import { createHash } from "node:crypto";

const { Pool } = pg;

// =====================================================
// VESTRA — ASHEN WARRIORS
// =====================================================

const BOT_NAME = "Vestra";
const TZ = "America/Chicago";
const GOOGLE_TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2";
const HIGHLIGHT_REACTION_THRESHOLD = 4;
const BRAND_COLOR = 0x6674F4;

let WELCOME_CATEGORY_ID = "1540332301962182686";
let IMPORTANT_CATEGORY_ID = "1507566069362069564";

const EXTRA_REACTION_TRANSLATION_CHANNELS = new Set([
  "1507566115994472568", // SxS Media
  "1538251460351889599"  // SxS Resources
]);

// =====================================================
// REQUIRED ENVIRONMENT VARIABLES
// =====================================================

for (const required of ["DISCORD_BOT", "GOOGLE_TRANSLATE_API_KEY", "DATABASE_URL"]) {
  if (!process.env[required]) {
    console.error(`❌ Missing Railway variable: ${required}`);
  }
}

// =====================================================
// CLIENT
// =====================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
    Partials.User,
    Partials.GuildMember
  ]
});

// =====================================================
// DATABASE
// =====================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function initDatabase() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY,
      primary_language TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS translation_groups (
      group_id TEXT PRIMARY KEY,
      source_message_id TEXT UNIQUE NOT NULL,
      source_channel_id TEXT NOT NULL,
      source_language TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_avatar TEXT,
      original_content TEXT DEFAULT '',
      attachment_urls JSONB DEFAULT '[]'::jsonb,
      reply_to_group_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS translation_messages (
      message_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES translation_groups(group_id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      language_key TEXT NOT NULL,
      is_source BOOLEAN DEFAULT FALSE,
      base_content TEXT DEFAULT '',
      webhook_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(group_id, language_key)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_translation_messages_group
      ON translation_messages(group_id)`,

    `CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL,
      group_id TEXT NOT NULL REFERENCES translation_groups(group_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      emoji_key TEXT NOT NULL,
      PRIMARY KEY(message_id, user_id, emoji_key)
    )`,

    `CREATE TABLE IF NOT EXISTS social_companions (
      original_message_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      companion_message_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS highlights (
      source_message_id TEXT PRIMARY KEY,
      highlight_message_id TEXT NOT NULL,
      source_channel_id TEXT NOT NULL,
      score INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS tournament_state (
      tournament TEXT PRIMARY KEY,
      active_date TEXT,
      round INTEGER DEFAULT 0,
      phase TEXT DEFAULT 'inactive',
      vote_ends_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS sent_events (
      event_key TEXT PRIMARY KEY,
      sent_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS onboarding_sessions (
      user_id TEXT PRIMARY KEY,
      language TEXT,
      reminders JSONB DEFAULT '[]'::jsonb,
      playstyle TEXT,
      social TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }

  console.log("✅ Persistent Postgres database ready.");
}

async function dbGetState(key) {
  const result = await pool.query(
    "SELECT value FROM bot_state WHERE key = $1",
    [key]
  );
  return result.rows[0]?.value ?? null;
}

async function dbSetState(key, value) {
  await pool.query(
    `INSERT INTO bot_state(key, value, updated_at)
     VALUES($1, $2::jsonb, NOW())
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

async function saveOnboardingSession(userId, session) {
  await pool.query(
    `INSERT INTO onboarding_sessions(user_id, language, reminders, playstyle, social, updated_at)
     VALUES($1, $2, $3::jsonb, $4, $5, NOW())
     ON CONFLICT(user_id) DO UPDATE SET
       language = EXCLUDED.language,
       reminders = EXCLUDED.reminders,
       playstyle = EXCLUDED.playstyle,
       social = EXCLUDED.social,
       updated_at = NOW()`,
    [
      userId,
      session.language || null,
      JSON.stringify(session.reminders || []),
      session.playstyle || null,
      session.social || null
    ]
  );
  sessions.set(userId, {
    language: session.language || null,
    reminders: [...(session.reminders || [])],
    playstyle: session.playstyle || null,
    social: session.social || null
  });
}

async function getOnboardingSession(userId) {
  if (sessions.has(userId)) return sessions.get(userId);

  const result = await pool.query(
    "SELECT language, reminders, playstyle, social FROM onboarding_sessions WHERE user_id = $1",
    [userId]
  );

  if (!result.rows[0]) return null;

  const row = result.rows[0];
  const session = {
    language: row.language || null,
    reminders: Array.isArray(row.reminders) ? row.reminders : [],
    playstyle: row.playstyle || null,
    social: row.social || null
  };

  sessions.set(userId, session);
  return session;
}

async function deleteOnboardingSession(userId) {
  sessions.delete(userId);
  await pool.query(
    "DELETE FROM onboarding_sessions WHERE user_id = $1",
    [userId]
  );
}

// =====================================================
// CHANNELS
// =====================================================

const CHANNELS = {
  REMINDERS: "1537611487768744046",
  START_HERE: "1540332552584167444",
  RULES: "1540332590891008093",
  ONBOARDING: "1540332651980787743",
  HELP: "1540332685216452610",
  INTRODUCTIONS: "1540407351469940888",
  PREFERENCES: "1540407411326591137",
  STAFF_REQUESTS: "1540870724242120776",
  HIGHLIGHTS: "1568080287848472657",
  EVENT_BOARD: "1568080487115792454"
};

let SOCIAL_CATEGORY_ID = "1542252166222315532";

const SOCIAL_CHANNELS = new Set([
  "1542252582469247016", // General
  "1542252701578961028", // Movies & Shows
  "1542252734076690442", // Other Gaming
  "1542252850808365226", // Foods
  "1542252884614184980", // Random Topics
  "1542252909222166628", // Memes
  "1542253001824272454", // Media
  "1542253232464601138"  // Music
]);

// =====================================================
// LANGUAGE CHANNELS
// =====================================================

const LANGUAGE_CHANNELS = {
  english: {
    code: "en",
    name: "English",
    emoji: "🇺🇸",
    channel: "1507565773336481966",
    role: "1540336707520434176"
  },
  spanish: {
    code: "es",
    name: "Spanish",
    emoji: "🇪🇸",
    channel: "1540387246752931900",
    role: "1540336749866131476"
  },
  french: {
    code: "fr",
    name: "French",
    emoji: "🇫🇷",
    channel: "1540387342408351924",
    role: "1540337010609365073"
  },
  german: {
    code: "de",
    name: "German",
    emoji: "🇩🇪",
    channel: "1540387464542167202",
    role: "1540337119493357668"
  },
  portuguese: {
    code: "pt",
    name: "Portuguese",
    emoji: "🇵🇹",
    channel: "1540387524709589002",
    role: "1540337336087482501"
  },
  japanese: {
    code: "ja",
    name: "Japanese",
    emoji: "🇯🇵",
    channel: "1540387566480531537",
    role: "1540337389900271676"
  }
};

const LANGUAGE_KEYS = Object.keys(LANGUAGE_CHANNELS);

function languageByChannel(channelId) {
  return Object.entries(LANGUAGE_CHANNELS).find(([, info]) => info.channel === channelId) || null;
}

// =====================================================
// ROLES
// =====================================================

const ASHEN_WARRIORS = "1507567323161038899";
const ONBOARDING_COMPLETE = "1540336639635628032";

const STAFF_ROLES = {
  OWNER: "1507567387774423171",
  ADMIN: "1507567296447516714",
  LEADER: "1508987283934543992",
  DEPUTY: "1507567404836847747",
  OFFICERS: "1507567452391870544"
};

const PROTECTED_ROLES = new Set(Object.values(STAFF_ROLES));

const LANGUAGES = Object.fromEntries(
  Object.entries(LANGUAGE_CHANNELS).map(([key, value]) => [key, {
    name: value.name,
    emoji: value.emoji,
    role: value.role
  }])
);

const PLAYSTYLE = {
  casual: { name: "Casual", emoji: "🌿", role: "1540337903497117736" },
  competitive: { name: "Competitive", emoji: "⚔️", role: "1540337984459513877" },
  both: { name: "Both", emoji: "🎮", role: "1540338047189655552" }
};

const SOCIAL = {
  chatty: { name: "Chatty", emoji: "💬", role: "1540338102244216902" },
  quiet: { name: "Quiet", emoji: "🌙", role: "1540338180291694604" },
  either: { name: "Either", emoji: "✨", role: "1540338259761176606" }
};

const REMINDERS = {
  reset: { name: "Reset", emoji: "🔄", role: "1537936033273086073" },
  morning: { name: "Morning Conquest", emoji: "🌅", role: "1537936135114854430" },
  night: { name: "Night Conquest", emoji: "🌌", role: "1537936185979183194" },
  opening: { name: "Clash Opening Call", emoji: "🔔", role: "1537936269043310752" },
  battle: { name: "Clash Battle Call", emoji: "⚔️", role: "1537936402497675265" },
  final: { name: "Clash Final Call", emoji: "🚨", role: "1537936646442451075" },
  registration: { name: "Guild Clash Registration", emoji: "⏰", role: "1537936738998296618" }
};

const TOURNAMENTS = {
  sever: {
    name: "Server Tournament",
    role: "1568090359127474228",
    emoji: "⚔️",
    voteMinutes: 5,
    rounds: 4
  },
  nexus: {
    name: "Nexus Tournament",
    role: "1568090644662980708",
    emoji: "🌀",
    voteMinutes: 10,
    rounds: 4
  }
};

const RESETTABLE_ROLES = new Set([
  ASHEN_WARRIORS,
  ONBOARDING_COMPLETE,
  ...Object.values(LANGUAGES).map(x => x.role),
  ...Object.values(PLAYSTYLE).map(x => x.role),
  ...Object.values(SOCIAL).map(x => x.role),
  ...Object.values(REMINDERS).map(x => x.role),
  ...Object.values(TOURNAMENTS).map(x => x.role)
]);

function isStaff(member) {
  return Object.values(STAFF_ROLES).some(roleId => member?.roles?.cache?.has(roleId));
}

// =====================================================
// ONBOARDING TEXT
// =====================================================

const TEXT = {
  english: {
    welcome: "Welcome to Ashen Warriors!",
    reminders: "Which reminder pings would you like?",
    playstyle: "What is your playstyle?",
    social: "What is your social preference?",
    finish: "Finish Onboarding",
    done: "Your onboarding is complete! Welcome to Ashen Warriors!"
  },
  spanish: {
    welcome: "¡Bienvenido/a a Ashen Warriors!",
    reminders: "¿Qué recordatorios quieres recibir?",
    playstyle: "¿Cuál es tu estilo de juego?",
    social: "¿Cuál es tu preferencia social?",
    finish: "Finalizar incorporación",
    done: "¡Tu incorporación está completa! ¡Bienvenido/a a Ashen Warriors!"
  },
  french: {
    welcome: "Bienvenue chez Ashen Warriors !",
    reminders: "Quels rappels souhaitez-vous recevoir ?",
    playstyle: "Quel est votre style de jeu ?",
    social: "Quelle est votre préférence sociale ?",
    finish: "Terminer l’intégration",
    done: "Votre intégration est terminée ! Bienvenue chez Ashen Warriors !"
  },
  german: {
    welcome: "Willkommen bei Ashen Warriors!",
    reminders: "Welche Erinnerungen möchtest du erhalten?",
    playstyle: "Wie ist dein Spielstil?",
    social: "Was ist deine soziale Präferenz?",
    finish: "Onboarding abschließen",
    done: "Dein Onboarding ist abgeschlossen! Willkommen bei Ashen Warriors!"
  },
  portuguese: {
    welcome: "Bem-vindo(a) ao Ashen Warriors!",
    reminders: "Quais lembretes você deseja receber?",
    playstyle: "Qual é o seu estilo de jogo?",
    social: "Qual é a sua preferência social?",
    finish: "Concluir integração",
    done: "Sua integração está concluída! Bem-vindo(a) ao Ashen Warriors!"
  },
  japanese: {
    welcome: "Ashen Warriorsへようこそ！",
    reminders: "どのリマインダーを受け取りたいですか？",
    playstyle: "プレイスタイルを選んでください。",
    social: "交流スタイルを選んでください。",
    finish: "オンボーディングを完了",
    done: "オンボーディングが完了しました！Ashen Warriorsへようこそ！"
  }
};

const sessions = new Map();

// =====================================================
// GENERAL HELPERS
// =====================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function limitText(text, max = 1900) {
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function chunks(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function getGuild() {
  const byKnownChannel =
    client.channels.cache.get(CHANNELS.START_HERE)?.guild ||
    client.channels.cache.get(WELCOME_CATEGORY_ID)?.guild;

  return byKnownChannel || client.guilds.cache.first() || null;
}

async function resolveAshenGuild(guildOverride = null) {
  if (guildOverride?.id) return guildOverride;

  const cached =
    client.channels.cache.get(CHANNELS.START_HERE)?.guild ||
    client.channels.cache.get(WELCOME_CATEGORY_ID)?.guild;

  if (cached) return cached;

  const startHere = await client.channels
    .fetch(CHANNELS.START_HERE)
    .catch(() => null);

  if (startHere?.guild) return startHere.guild;

  const welcomeCategory = await client.channels
    .fetch(WELCOME_CATEGORY_ID)
    .catch(() => null);

  if (welcomeCategory?.guild) return welcomeCategory.guild;

  return client.guilds.cache.first() || null;
}

function safeDisplayName(member, user) {
  return member?.displayName || user?.globalName || user?.username || "Member";
}

function getMentionIds(text) {
  const users = new Set();
  const roles = new Set();
  const regex = /<@!?(\d+)>|<@&(\d+)>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[1]) users.add(match[1]);
    if (match[2]) roles.add(match[2]);
  }
  return { users: [...users], roles: [...roles] };
}

function formatAttachments(attachments) {
  return [...attachments.values()].map(a => `📎 ${a.url}`).join("\n");
}

function emojiKey(emoji) {
  if (emoji.id) return emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
  return emoji.name;
}

function brandEmbed(title, description = "") {
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(title);

  if (description) embed.setDescription(description);
  return embed;
}

async function findWelcomeChannelByName(guild, name) {
  return guild.channels.cache.find(
    channel =>
      channel.isTextBased?.() &&
      channel.name === name
  ) || null;
}

async function upsertBotPanel(channelOrId, stateKey, payload, footerTag) {
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

async function cleanupLegacyWelcomePanels() {
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

// =====================================================
// GOOGLE TRANSLATION — DISCORD CONTENT PROTECTION
// =====================================================

const translationCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

function protectDiscordContent(input) {
  let text = input || "";
  const replacements = [];

  const protect = regex => {
    text = text.replace(regex, match => {
      const token = `ZXQVESTRA${replacements.length}QXZ`;
      replacements.push({ token, original: match });
      return token;
    });
  };

  // Keep code exactly intact.
  protect(/```[\s\S]*?```/g);
  protect(/`[^`\n]+`/g);

  // Discord structures.
  protect(/<a?:[A-Za-z0-9_]+:\d+>/g);
  protect(/<@!?\d+>|<@&\d+>|<#\d+>|<t:\d+(?::[tTdDfFR])?>/g);

  // Links / invites / media URLs.
  protect(/https?:\/\/[^\s<>]+/g);

  return { text, replacements };
}

function restoreDiscordContent(input, replacements) {
  let text = input || "";
  for (const item of replacements) {
    text = text.split(item.token).join(item.original);
  }
  return text;
}

function stripProtectedForCheck(input) {
  let text = input || "";
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/`[^`\n]+`/g, " ");
  text = text.replace(/<a?:[A-Za-z0-9_]+:\d+>/g, " ");
  text = text.replace(/<@!?\d+>|<@&\d+>|<#\d+>|<t:\d+(?::[tTdDfFR])?>/g, " ");
  text = text.replace(/https?:\/\/[^\s<>]+/g, " ");
  return text;
}

function hasTranslatableText(input) {
  return /[\p{L}\p{N}]/u.test(stripProtectedForCheck(input));
}

function decodeGoogleText(text) {
  return (text || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function translationCacheKey(text, source, target) {
  return createHash("sha256").update(`${source || "auto"}|${target}|${text}`).digest("hex");
}

async function googleTranslate(text, targetCode, sourceCode = null) {
  if (!text || !hasTranslatableText(text)) return text;
  if (sourceCode && sourceCode === targetCode) return text;

  const key = translationCacheKey(text, sourceCode, targetCode);
  const cached = translationCache.get(key);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.text;

  const protectedMessage = protectDiscordContent(text);
  const body = {
    q: protectedMessage.text,
    target: targetCode,
    format: "text"
  };
  if (sourceCode) body.source = sourceCode;

  const response = await fetch(GOOGLE_TRANSLATE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-goog-api-key": process.env.GOOGLE_TRANSLATE_API_KEY
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Google Translation HTTP ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = await response.json();
  const translated = data?.data?.translations?.[0]?.translatedText;
  if (typeof translated !== "string") throw new Error("Google returned no translated text.");

  const restored = restoreDiscordContent(decodeGoogleText(translated), protectedMessage.replacements);
  translationCache.set(key, { text: restored, time: Date.now() });

  if (translationCache.size > 2000) {
    const first = translationCache.keys().next().value;
    if (first) translationCache.delete(first);
  }

  return restored;
}

// =====================================================
// PRIMARY LANGUAGE / USER PREFERENCES
// =====================================================

async function savePrimaryLanguage(userId, languageKey) {
  if (!LANGUAGE_CHANNELS[languageKey]) return;
  await pool.query(
    `INSERT INTO user_preferences(user_id, primary_language, created_at, updated_at)
     VALUES($1, $2, NOW(), NOW())
     ON CONFLICT(user_id) DO UPDATE SET primary_language = EXCLUDED.primary_language, updated_at = NOW()`,
    [userId, languageKey]
  );
}

async function inferPrimaryLanguage(member) {
  const saved = await pool.query(
    "SELECT primary_language FROM user_preferences WHERE user_id = $1",
    [member.id]
  );

  const savedLanguage = saved.rows[0]?.primary_language;
  if (savedLanguage && LANGUAGE_CHANNELS[savedLanguage]) return savedLanguage;

  const owned = LANGUAGE_KEYS.filter(key => member.roles.cache.has(LANGUAGE_CHANNELS[key].role));
  let chosen = owned.length === 1 ? owned[0] : owned.includes("english") ? "english" : owned[0] || "english";
  await savePrimaryLanguage(member.id, chosen);
  return chosen;
}

async function loadPrimaryLanguageMap(userIds) {
  if (!userIds.length) return new Map();
  const result = await pool.query(
    "SELECT user_id, primary_language FROM user_preferences WHERE user_id = ANY($1::text[])",
    [userIds]
  );
  return new Map(result.rows.map(row => [row.user_id, row.primary_language]));
}

function inferPrimaryFromRoles(member, savedMap) {
  const saved = savedMap.get(member.id);
  if (saved && LANGUAGE_CHANNELS[saved]) return saved;
  const owned = LANGUAGE_KEYS.filter(key => member.roles.cache.has(LANGUAGE_CHANNELS[key].role));
  if (owned.length === 1) return owned[0];
  if (owned.includes("english")) return "english";
  return owned[0] || "english";
}

// =====================================================
// ONBOARDING UI
// =====================================================

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
          label: item.name,
          value: key,
          emoji: item.emoji
        })),
        ...Object.entries(TOURNAMENTS).map(([key, item]) => ({
          label: `${item.name} Pings`,
          value: `tournament:${key}`,
          emoji: item.emoji
        })),
        { label: "No reminders", value: "none", emoji: "🔕" }
      )
  );
}

function onboardingEmbed(step, title, description) {
  return brandEmbed(`${step} · ${title}`, description)
    .setFooter({ text: "Vestra • Ashen Warriors Onboarding" });
}

function onboardingStepContent(step, title, description) {
  return `# ${title}

**${step}**

✦ ───────────── ✦

${description}

✦ ───────────── ✦

*Vestra • Ashen Warriors Onboarding*`;
}

function onboardingSummaryEmbed(session) {
  const language = session.language ? LANGUAGES[session.language] : null;
  const reminderNames = (session.reminders || []).map(key => {
    if (REMINDERS[key]) return `${REMINDERS[key].emoji} ${REMINDERS[key].name}`;
    if (key.startsWith("tournament:")) {
      const tournament = TOURNAMENTS[key.split(":")[1]];
      return tournament ? `${tournament.emoji} ${tournament.name}` : key;
    }
    return key;
  });

  const playstyle = session.playstyle ? PLAYSTYLE[session.playstyle] : null;
  const social = session.social ? SOCIAL[session.social] : null;

  return brandEmbed(
    "✨ Your Ashen Setup Is Ready",
    "Your setup is complete. Review everything below, then step into Ashen Warriors."
  )
    .addFields(
      {
        name: "🌎 Primary Language",
        value: language ? `${language.emoji} ${language.name}` : "Not selected",
        inline: true
      },
      {
        name: "🎮 Playstyle",
        value: playstyle ? `${playstyle.emoji} ${playstyle.name}` : "Skipped",
        inline: true
      },
      {
        name: "💬 Social",
        value: social ? `${social.emoji} ${social.name}` : "Skipped",
        inline: true
      },
      {
        name: "🔔 Pings",
        value: reminderNames.length ? reminderNames.join("\n") : "🔕 No reminders"
      }
    )
    .setFooter({ text: "Vestra • Your choices can be changed later in Role Preferences" });
}

function playstyleMenu(language) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("onboard_playstyle")
      .setPlaceholder(TEXT[language].playstyle)
      .addOptions(
        { label: "Casual", value: "casual", emoji: "🌿" },
        { label: "Competitive", value: "competitive", emoji: "⚔️" },
        { label: "Both", value: "both", emoji: "🎮" },
        { label: "Skip", value: "skip", emoji: "⏭️" }
      )
  );
}

function socialMenu(language) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("onboard_social")
      .setPlaceholder(TEXT[language].social)
      .addOptions(
        { label: "Chatty", value: "chatty", emoji: "💬" },
        { label: "Quiet", value: "quiet", emoji: "🌙" },
        { label: "Either", value: "either", emoji: "✨" },
        { label: "Skip", value: "skip", emoji: "⏭️" }
      )
  );
}

function finishButton(language) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("onboard_finish")
      .setLabel(TEXT[language].finish)
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
  );
}

// =====================================================
// START HERE / ONBOARDING / HELP / PREFERENCES
// =====================================================

async function setupStartHere() {
  const content = `# 🖤 Welcome to Ashen Warriors

We’re glad you’re here!

Ashen is your place to **play, plan, ask for help, meet people, and stay connected** outside of Sword x Staff.

✦ ───────────── ✦

# ✨ Your Path Into Ashen

## 1. 📜 Read the Rules
Head to <#${CHANNELS.RULES}> and take a minute to look through the server guidelines.

They’re simple — be respectful, use common sense, and don’t intentionally make the server uncomfortable for other people.

## 2. 🌎 Complete Onboarding
Go to <#${CHANNELS.ONBOARDING}> and press **🌎 Start Onboarding**.

You’ll set your:
🌎 **Primary language**
🔔 **Guild & tournament alerts**
🎮 **Playstyle**
💬 **Social vibe**

Once you finish, the rest of Ashen unlocks automatically.

## 3. ✨ Customize Vestra Anytime
Use <#${CHANNELS.PREFERENCES}> whenever you want to change your language access, notification language, reminders, tournament alerts, playstyle, or social preference.

## 4. 🆘 Get Help
Visit <#${CHANNELS.HELP}> for game help, strategies, team finding, Discord help, FAQs, or private staff support.

## 5. 👋 Meet the Guild
After onboarding, Vestra introduces you in <#${CHANNELS.INTRODUCTIONS}> with your own Ashen member card.

✦ ───────────── ✦

# 🌍 Language & Translation
General language chats are automatically mirrored and translated between 🇺🇸 🇪🇸 🇫🇷 🇩🇪 🇵🇹 🇯🇵.

In other supported text channels, react **🌐** to any message and Vestra will temporarily translate it into **your primary language**.

# 🔔 Your Alerts, Your Choice
Vestra only sends the alerts **you choose**, in your primary notification language — including Clash reminders and tournament notifications.

# 🖤 Welcome Home
Talk, joke around, share things, ask for help, play together, and get to know people.

**Ashen Warriors is your guild too. Make yourself at home. 🖤**`;

  await upsertBotPanel(
    CHANNELS.START_HERE,
    "panel_start_here",
    { content, embeds: [], components: [] },
    "# 🖤 Welcome to Ashen Warriors"
  );
}

async function setupRulesPanel() {
  const content = `# 🖤 Ashen Rules — The Big Picture

The full rules are posted in this channel. This is the easy version to keep in the back of your mind while you’re here.

## 🤝 Community
Be cool to each other. Joking, teasing, and chaos are fine — just know when to stop, keep public drama from taking over, and try to use the right channels.

## 🛡️ Safety & Fairness
No genuine harassment, scams, account stealing, malicious links, cheats, or intentionally leaking private guild or staff information.

## 🎮 Guild Expectations
Participate when you can, communicate when plans change, and remember that **real life comes first**. Nobody is expected to treat Ashen like a job.

# ❤️ Most Importantly
**This is a guild, not a workplace.**

Talk, joke around, be weird, make friends, share memes, play together, and enjoy yourself.

Mistakes happen. Most small issues will get a friendly reminder before anything serious happens. 🖤`;

  await upsertBotPanel(
    CHANNELS.RULES,
    "panel_rules_guide",
    { content, embeds: [], components: [] },
    "# 🖤 Ashen Rules — The Big Picture"
  );
}

async function setupOnboardingPanel() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("start_onboarding")
      .setLabel("Start My Ashen Setup")
      .setEmoji("✨")
      .setStyle(ButtonStyle.Primary)
  );

  const content = `# 🖤 Build Your Ashen Setup

Vestra will personalize the server around **you** in four quick choices.

✦ ───────────── ✦

## 🌎 1 · Set Your Language
Choose the language Vestra should use for your notifications and 🌐 translations.

## 🔔 2 · Choose Your Alerts
Pick only the reminders you actually want — including guild events, **Server Tournament**, and **Nexus Tournament**.

## 🎮 3 · Pick Your Playstyle
Choose **Casual**, **Competitive**, or **Both**.

## 💬 4 · Set Your Social Vibe
Choose **Chatty**, **Quiet**, or **Either** so people have a little idea of your vibe.

✦ ───────────── ✦

## ✨ Then You’re In
Vestra saves your setup, assigns your roles, introduces you to the guild, and unlocks the rest of Ashen.

**Ready to make Ashen yours? 🖤**`;

  await upsertBotPanel(
    CHANNELS.ONBOARDING,
    "panel_onboarding",
    { content, embeds: [], components: [row] },
    "# 🖤 Build Your Ashen Setup"
  );
}

const preferenceMessages = {
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

async function setupPreferences() {
  const channel = await client.channels.fetch(CHANNELS.PREFERENCES);
  if (!channel?.isTextBased()) return;

  preferenceMessages.languages = await createPreferencePanel(
    channel,
    "panel_pref_languages",
    `# 🌎 Language Access

React to **every language chat** you want access to. You can join one or all of them.

🇺🇸 **English**
🇪🇸 **Spanish**
🇫🇷 **French**
🇩🇪 **German**
🇵🇹 **Portuguese**
🇯🇵 **Japanese**

*Your primary notification language is managed separately in My Vestra Settings.*`,
    Object.values(LANGUAGES).map(x => x.emoji),
    "# 🌎 Language Access"
  );

  preferenceMessages.reminders = await createPreferencePanel(
    channel,
    "panel_pref_reminders",
    `# 🔔 Game & Guild Reminder Pings

React to every reminder you want. Vestra sends the actual alert in your **primary notification language**.

🔄 **Reset**
🌅 **Morning Conquest**
🌌 **Night Conquest**
🔔 **Clash Opening Call**
⚔️ **Clash Battle Call**
🚨 **Clash Final Call**
⏰ **Guild Clash Registration**

*Only the reminders you choose will ping you.*`,
    Object.values(REMINDERS).map(x => x.emoji),
    "# 🔔 Game & Guild Reminder Pings"
  );

  preferenceMessages.tournaments = await createPreferencePanel(
    channel,
    "panel_pref_tournaments",
    `# 🏆 Tournament Pings

Want tournament alerts? React below. Vestra sends them in your **primary notification language**.

⚔️ **Server Tournament**
Starts **2:00 PM Standard / 3:00 PM DST**

🌀 **Nexus Tournament**
Starts **3:00 PM Standard / 4:00 PM DST**

Voting rounds are opened manually by Ashen staff when each battle is ready.`,
    Object.values(TOURNAMENTS).map(x => x.emoji),
    "# 🏆 Tournament Pings"
  );

  preferenceMessages.playstyle = await createPreferencePanel(
    channel,
    "panel_pref_playstyle",
    `# 🎮 Playstyle

Choose the option that fits you best.

🌿 **Casual** — here to relax and have fun
⚔️ **Competitive** — you like pushing and competing
🎮 **Both** — depends on the day`,
    Object.values(PLAYSTYLE).map(x => x.emoji),
    "# 🎮 Playstyle"
  );

  preferenceMessages.social = await createPreferencePanel(
    channel,
    "panel_pref_social",
    `# 💬 Social Preference

Let people know how you usually like to interact.

💬 **Chatty** — come talk to me!
🌙 **Quiet** — I’m around, just quieter
✨ **Either** — I can go either way`,
    Object.values(SOCIAL).map(x => x.emoji),
    "# 💬 Social Preference"
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("settings_open")
      .setLabel("Open My Vestra Settings")
      .setEmoji("✨")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("settings_card")
      .setLabel("My Vestra Card")
      .setEmoji("👤")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("admin_apply_theme")
      .setLabel("Apply Ashen Theme")
      .setEmoji("🖤")
      .setStyle(ButtonStyle.Secondary)
  );

  const settingsContent = `# ✨ My Vestra Settings

Want everything in one place? Open your personal Vestra panel to review and change your setup anytime.

🌎 **Language access**
🔔 **Primary notification language**
⏰ **Game & guild pings**
🏆 **Tournament pings**
🎮 **Playstyle**
💬 **Social preference**

## 💡 Quick Tip
The reactions above are perfect for fast changes. **My Vestra Settings** is best when you want to review everything at once.`;

  await upsertBotPanel(
    channel,
    "panel_pref_settings",
    { content: settingsContent, embeds: [], components: [row] },
    "# ✨ My Vestra Settings"
  );

  console.log("✅ Preference panels and Vestra settings ready.");
}

async function setupHelpCenter() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("help_game")
      .setLabel("Game Help")
      .setEmoji("🎮")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("help_team")
      .setLabel("Need a Team")
      .setEmoji("👥")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("help_staff")
      .setLabel("Ask Staff")
      .setEmoji("🛡️")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("help_discord")
      .setLabel("Discord Help")
      .setEmoji("⚙️")
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("help_faq")
      .setLabel("FAQ")
      .setEmoji("❓")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("help_guide")
      .setLabel("Server Guide")
      .setEmoji("🧭")
      .setStyle(ButtonStyle.Secondary)
  );

  const content = `# 🖤 Ashen Help Center

Need something? Pick what you’re looking for below and Vestra will get you to the right place.

## 🎮 Community Help
**Game Help** — builds, mechanics, strategies, or anything SxS
**Need a Team** — find people to run something with

## 🛡️ Private Staff Help
**Ask Staff** — privately contact Ashen leadership. Other members won’t see your request.

## ⚙️ Server Support
**Discord Help** — server or Discord problems
**FAQ** — quick answers to common questions
**Server Guide** — figure out where everything is

*You don’t need to hunt down a staff member just to ask something. 🖤*`;

  await upsertBotPanel(
    CHANNELS.HELP,
    "panel_help_center",
    { content, embeds: [], components: [row1, row2] },
    "# 🖤 Ashen Help Center"
  );

  console.log("✅ Help Center ready.");
}

async function setupGuildPingsPanel() {
  const content = `# 🔔 Ashen Guild Ping Log

This channel is Vestra’s **event history** — a clean record of the reminders that were sent.

## 🌎 Where Your Real Ping Goes
If you’re subscribed to an event, Vestra sends your actual ping in your **primary-language General channel**.

## 🔕 Why This Channel Stays Quiet
Messages here intentionally do **not** ping roles or @everyone. This is the master log so staff can confirm what Vestra sent and when.

*Your personal notification choices are managed in <#${CHANNELS.PREFERENCES}>.*`;

  await upsertBotPanel(
    CHANNELS.REMINDERS,
    "panel_guild_pings",
    { content, embeds: [], components: [] },
    "# 🔔 Ashen Guild Ping Log"
  );
}

async function setupIntroductionPanel() {
  const content = `# 👋 Welcome to the Ashen Family

This is where newly onboarded members get introduced!

Say hi, welcome people in, and don’t be afraid to start a conversation. Ashen is a guild first, but it’s also a community. 🖤

## ✨ New Member Introductions
When someone finishes onboarding, Vestra posts a little member card with their:

🌎 **Primary language**
🎮 **Playstyle**
💬 **Social vibe**

It’s just enough to make breaking the ice a little easier.

**See a new face? Go say hi!**`;

  await upsertBotPanel(
    CHANNELS.INTRODUCTIONS,
    "panel_introductions",
    { content, embeds: [], components: [] },
    "# 👋 Welcome to the Ashen Family"
  );
}

async function setupStaffRequestsPanel() {
  const content = `# 🛡️ Ashen Staff Requests

Private member requests from the Help Center appear here for Ashen leadership.

## 📬 What You’ll See
Each request shows the member, their message, when it was submitted, and its current status.

## 🔒 Keep It Here
This channel is for staff handling only. Keep member requests and sensitive details inside the staff team.

*Vestra will ping the appropriate leadership roles when a new request arrives.*`;

  await upsertBotPanel(
    CHANNELS.STAFF_REQUESTS,
    "panel_staff_requests",
    { content, embeds: [], components: [] },
    "# 🛡️ Ashen Staff Requests"
  );
}

async function setupGuildMembersPanel() {
  const guild = getGuild();
  if (!guild) return;

  const channel = guild.channels.cache.find(
    ch =>
      ch.isTextBased?.() &&
      (ch.name.includes("guild-members") || ch.name.includes("ashen-members"))
  ) || null;
  if (!channel) return;

  await guild.members.fetch().catch(() => {});

  const humanMembers = guild.members.cache.filter(member => !member.user.bot);
  const staffCount = humanMembers.filter(member => isStaff(member)).size;
  const onboardedCount = humanMembers.filter(
    member => member.roles.cache.has(ONBOARDING_COMPLETE)
  ).size;

  const content = `# 🖤 Ashen Guild Members

A little snapshot of the community that makes Ashen Warriors what it is.

## 👥 Our Community
**${humanMembers.size}** members
**${staffCount}** staff members
**${onboardedCount}** members fully onboarded

## ✨ Your Vestra Card
Want to see your own setup? Your card shows your language access, primary notification language, pings, playstyle, and social preference.

Press the button below anytime to view it.`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("settings_card")
      .setLabel("View My Vestra Card")
      .setEmoji("👤")
      .setStyle(ButtonStyle.Primary)
  );

  await upsertBotPanel(
    channel,
    "panel_guild_members",
    { content, embeds: [], components: [row] },
    "# 🖤 Ashen Guild Members"
  );
}

function createHelpModal(customId, title, label, placeholder) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);

  const input = new TextInputBuilder()
    .setCustomId("help_details")
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(5)
    .setMaxLength(1000)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(input)
  );

  return modal;
}

async function createHelpThread(interaction, type, emoji, details) {
  const channel = await interaction.guild.channels.fetch(CHANNELS.HELP);

  if (!channel?.isTextBased()) {
    await interaction.reply({
      content: "❌ Vestra couldn't access the help channel.",
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  const embed = brandEmbed(
    `${emoji} ${type}`,
    details
  )
    .addFields({
      name: "👤 Asked by",
      value: `${interaction.member}`,
      inline: true
    })
    .setFooter({ text: "Vestra • Ashen Help" })
    .setTimestamp();

  const post = await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] }
  });

  const safeName = `${type}-${interaction.user.username}`
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .slice(0, 90);

  const thread = await post.startThread({
    name: safeName,
    autoArchiveDuration: 1440
  });

  await thread.send({
    content: `${interaction.member}, your help thread is ready! 🖤`,
    allowedMentions: {
      parse: [],
      users: [interaction.user.id]
    }
  });

  await interaction.reply({
    content: `✅ Your request has been posted: ${thread}`,
    flags: MessageFlags.Ephemeral
  });
}

// =====================================================
// WELCOME / MEMBER CARDS
// =====================================================

function welcomeCard(member, languageName, playstyleName, socialName) {
  return brandEmbed(
    "🖤 A New Ashen Warrior Has Arrived",
    `Welcome **${member.displayName}** to Ashen Warriors!\n\n✨ **Joined the Ashen family**\nSay hi, make them feel at home, and maybe drag them into something fun.`
  )
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "🌎 Primary Language", value: languageName, inline: true },
      { name: "🎮 Playstyle", value: playstyleName, inline: true },
      { name: "💬 Social Vibe", value: socialName, inline: true }
    )
    .setFooter({ text: "Vestra • Welcome to Ashen Warriors" })
    .setTimestamp();
}

async function memberCardEmbed(member) {
  const primary = await inferPrimaryLanguage(member);
  const languageAccess = LANGUAGE_KEYS
    .filter(key => member.roles.cache.has(LANGUAGE_CHANNELS[key].role))
    .map(key => `${LANGUAGE_CHANNELS[key].emoji} ${LANGUAGE_CHANNELS[key].name}`);

  const reminderNames = Object.values(REMINDERS)
    .filter(item => member.roles.cache.has(item.role))
    .map(item => item.name);

  const tourneys = Object.values(TOURNAMENTS)
    .filter(item => member.roles.cache.has(item.role))
    .map(item => item.name);

  const playstyle = Object.values(PLAYSTYLE).find(item => member.roles.cache.has(item.role))?.name || "Not set";
  const social = Object.values(SOCIAL).find(item => member.roles.cache.has(item.role))?.name || "Not set";
  const totalPings = reminderNames.length + tourneys.length;

  return new EmbedBuilder()
    .setTitle(`👤 ${member.displayName}'s Vestra Card`)
    .setDescription(
      `${LANGUAGE_CHANNELS[primary].emoji} **${LANGUAGE_CHANNELS[primary].name}**  •  🔔 **${totalPings} pings**  •  🎮 **${playstyle}**  •  💬 **${social}**`
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "🔔 Primary Notification Language", value: `${LANGUAGE_CHANNELS[primary].emoji} ${LANGUAGE_CHANNELS[primary].name}` },
      { name: "🌎 Language Access", value: languageAccess.join(" • ") || "None" },
      { name: "🎮 Playstyle", value: playstyle, inline: true },
      { name: "💬 Social", value: social, inline: true },
      { name: "🔔 Game Pings", value: reminderNames.join(", ") || "None" },
      { name: "🏆 Tournament Pings", value: tourneys.join(", ") || "None" }
    )
    .setFooter({ text: "Vestra • Your Ashen profile" });
}

// =====================================================
// SETTINGS PANEL
// =====================================================

function settingsHomeComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("settings_languages").setLabel("Language Access").setEmoji("🌎").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("settings_notify").setLabel("Notification Language").setEmoji("🔔").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("settings_reminders").setLabel("Game Pings").setEmoji("⏰").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("settings_tournaments").setLabel("Tournament Pings").setEmoji("🏆").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("settings_playstyle").setLabel("Playstyle").setEmoji("🎮").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("settings_social").setLabel("Social").setEmoji("💬").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("settings_card").setLabel("My Vestra Card").setEmoji("👤").setStyle(ButtonStyle.Success)
    )
  ];
}

function settingsHomeEmbed() {
  return brandEmbed(
    "✨ Customize Your Ashen Experience",
    "This is your personal Vestra control center. Everything here changes how Ashen works **for you**."
  )
    .addFields(
      {
        name: "🌎 Language",
        value: "Language access + your primary notification language",
        inline: true
      },
      {
        name: "🔔 Alerts",
        value: "Guild reminders + tournament pings",
        inline: true
      },
      {
        name: "🎮 Your Vibe",
        value: "Playstyle + social preference",
        inline: true
      }
    )
    .setFooter({ text: "Vestra • Changes save instantly" });
}

function backButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("settings_back").setLabel("Back").setEmoji("↩️").setStyle(ButtonStyle.Secondary)
  );
}

async function updateSingleChoiceRole(member, group, selectedKey) {
  for (const [key, item] of Object.entries(group)) {
    if (member.roles.cache.has(item.role) && key !== selectedKey) {
      await member.roles.remove(item.role).catch(() => {});
    }
  }
  if (selectedKey && group[selectedKey]) await member.roles.add(group[selectedKey].role);
}

// =====================================================
// TRANSLATION WEBHOOKS / PERSISTENT MAPPING
// =====================================================

const translationWebhooks = new Map();
const destinationChains = new Map(LANGUAGE_KEYS.map(key => [key, Promise.resolve()]));

async function getTranslationWebhook(channel) {
  if (translationWebhooks.has(channel.id)) return translationWebhooks.get(channel.id);
  const webhooks = await channel.fetchWebhooks();
  let webhook = webhooks.find(hook => hook.owner?.id === client.user.id && hook.name === "Vestra Translator");
  if (!webhook) webhook = await channel.createWebhook({ name: "Vestra Translator" });
  translationWebhooks.set(channel.id, webhook);
  return webhook;
}

function queueDestination(languageKey, task) {
  const previous = destinationChains.get(languageKey) || Promise.resolve();
  const next = previous.then(task).catch(error => {
    console.error(`❌ ${languageKey} translation queue:`, error.message);
  });
  destinationChains.set(languageKey, next);
  return next;
}

async function getGroupByMessageId(messageId) {
  const result = await pool.query(
    `SELECT tm.*, tg.source_message_id, tg.source_channel_id, tg.source_language,
            tg.author_id, tg.author_name, tg.author_avatar, tg.original_content,
            tg.attachment_urls, tg.reply_to_group_id
     FROM translation_messages tm
     JOIN translation_groups tg ON tg.group_id = tm.group_id
     WHERE tm.message_id = $1`,
    [messageId]
  );
  return result.rows[0] || null;
}

async function getTargetCopy(groupId, languageKey) {
  const result = await pool.query(
    "SELECT * FROM translation_messages WHERE group_id = $1 AND language_key = $2",
    [groupId, languageKey]
  );
  return result.rows[0] || null;
}

async function buildReplyHeader(replyToGroupId, targetLanguage, guildId) {
  if (!replyToGroupId) return "";
  const copy = await getTargetCopy(replyToGroupId, targetLanguage);
  if (!copy) return "↪️ **Reply**\n";
  const jump = `https://discord.com/channels/${guildId}/${copy.channel_id}/${copy.message_id}`;
  return `↪️ [**Replying to this message**](<${jump}>)\n`;
}

async function reactionSummary(groupId) {
  const result = await pool.query(
    `SELECT emoji_key, COUNT(DISTINCT user_id)::int AS count
     FROM message_reactions
     WHERE group_id = $1
     GROUP BY emoji_key
     ORDER BY count DESC, emoji_key ASC`,
    [groupId]
  );
  if (!result.rows.length) return "";
  return `\n\n—\n${result.rows.map(row => `${row.emoji_key} ${row.count}`).join("   ")}`;
}

async function editTranslatedCopy(row, content, allowedMentions = { parse: [] }) {
  const channel = await client.channels.fetch(row.channel_id).catch(() => null);
  if (!channel?.isTextBased()) return;
  const webhook = await getTranslationWebhook(channel);
  try {
    await webhook.editMessage(row.message_id, { content: limitText(content, 1990), allowedMentions });
  } catch (error) {
    if (error?.code === 10008) {
      await pool.query("DELETE FROM translation_messages WHERE message_id = $1", [row.message_id]);
    } else {
      throw error;
    }
  }
}

async function createTranslatedCopy(message, groupId, sourceKey, targetKey, replyToGroupId) {
  const targetInfo = LANGUAGE_CHANNELS[targetKey];
  const sourceInfo = LANGUAGE_CHANNELS[sourceKey];
  const targetChannel = await client.channels.fetch(targetInfo.channel);
  if (!targetChannel?.isTextBased()) throw new Error(`${targetInfo.name} channel unavailable`);

  let translated = message.content || "";
  if (message.content) {
    translated = await googleTranslate(message.content, targetInfo.code, sourceInfo.code);
  }

  const replyHeader = await buildReplyHeader(replyToGroupId, targetKey, message.guild.id);
  const attachments = formatAttachments(message.attachments);
  let base = [replyHeader.trimEnd(), translated, attachments].filter(Boolean).join("\n");
  base = limitText(base, 1850);

  const webhook = await getTranslationWebhook(targetChannel);
  const mentions = getMentionIds(message.content || "");
  const summary = await reactionSummary(groupId);
  const sent = await webhook.send({
    content: `${base}${summary}`,
    username: `${safeDisplayName(message.member, message.author)} • ${sourceInfo.emoji}`,
    avatarURL: message.author.displayAvatarURL({ extension: "png", size: 256 }),
    allowedMentions: {
      parse: [],
      users: mentions.users,
      roles: mentions.roles
    }
  });

  await pool.query(
    `INSERT INTO translation_messages(message_id, group_id, channel_id, language_key, is_source, base_content, webhook_id)
     VALUES($1, $2, $3, $4, FALSE, $5, $6)
     ON CONFLICT(group_id, language_key) DO UPDATE SET
       message_id = EXCLUDED.message_id,
       channel_id = EXCLUDED.channel_id,
       base_content = EXCLUDED.base_content,
       webhook_id = EXCLUDED.webhook_id`,
    [sent.id, groupId, targetInfo.channel, targetKey, base, webhook.id]
  );

  console.log(`✅ Google translation ${sourceInfo.name} → ${targetInfo.name}: ${message.author.username}`);
}

async function handleGeneralMessageCreate(message) {
  const sourceEntry = languageByChannel(message.channel.id);
  if (!sourceEntry) return;
  const [sourceKey] = sourceEntry;
  if (!message.content && message.attachments.size === 0) return;

  let replyToGroupId = null;
  if (message.reference?.messageId) {
    const referenced = await getGroupByMessageId(message.reference.messageId).catch(() => null);
    replyToGroupId = referenced?.group_id || null;
  }

  const attachmentURLs = [...message.attachments.values()].map(a => a.url);

  await pool.query(
    `INSERT INTO translation_groups(
       group_id, source_message_id, source_channel_id, source_language,
       author_id, author_name, author_avatar, original_content, attachment_urls, reply_to_group_id
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
     ON CONFLICT(group_id) DO NOTHING`,
    [
      message.id,
      message.id,
      message.channel.id,
      sourceKey,
      message.author.id,
      safeDisplayName(message.member, message.author),
      message.author.displayAvatarURL({ extension: "png", size: 256 }),
      message.content || "",
      JSON.stringify(attachmentURLs),
      replyToGroupId
    ]
  );

  await pool.query(
    `INSERT INTO translation_messages(message_id, group_id, channel_id, language_key, is_source, base_content)
     VALUES($1,$2,$3,$4,TRUE,$5)
     ON CONFLICT(message_id) DO NOTHING`,
    [message.id, message.id, message.channel.id, sourceKey, message.content || ""]
  );

  for (const targetKey of LANGUAGE_KEYS) {
    if (targetKey === sourceKey) continue;
    queueDestination(targetKey, () => createTranslatedCopy(message, message.id, sourceKey, targetKey, replyToGroupId));
  }
}

async function handleGeneralMessageUpdate(message) {
  const mapping = await getGroupByMessageId(message.id);
  if (!mapping?.is_source) return;

  const sourceKey = mapping.source_language;
  const attachmentURLs = [...message.attachments.values()].map(a => a.url);
  await pool.query(
    `UPDATE translation_groups
     SET original_content = $2, attachment_urls = $3::jsonb
     WHERE group_id = $1`,
    [mapping.group_id, message.content || "", JSON.stringify(attachmentURLs)]
  );

  const copies = await pool.query(
    "SELECT * FROM translation_messages WHERE group_id = $1 AND is_source = FALSE",
    [mapping.group_id]
  );
  const summary = await reactionSummary(mapping.group_id);

  for (const copy of copies.rows) {
    queueDestination(copy.language_key, async () => {
      const targetInfo = LANGUAGE_CHANNELS[copy.language_key];
      const sourceInfo = LANGUAGE_CHANNELS[sourceKey];
      let translated = message.content || "";
      if (message.content) translated = await googleTranslate(message.content, targetInfo.code, sourceInfo.code);
      const replyHeader = await buildReplyHeader(mapping.reply_to_group_id, copy.language_key, message.guild.id);
      const attachments = formatAttachments(message.attachments);
      const base = limitText([replyHeader.trimEnd(), translated, attachments].filter(Boolean).join("\n"), 1850);
      const mentions = getMentionIds(message.content || "");

      await pool.query("UPDATE translation_messages SET base_content = $2 WHERE message_id = $1", [copy.message_id, base]);
      await editTranslatedCopy(copy, `${base}${summary}`, {
        parse: [], users: mentions.users, roles: mentions.roles
      });
    });
  }

  console.log(`✏️ Synced edit across translations: ${message.id}`);
}

async function deleteTranslatedGroup(groupId) {
  const copies = await pool.query(
    "SELECT * FROM translation_messages WHERE group_id = $1 AND is_source = FALSE",
    [groupId]
  );
  for (const row of copies.rows) {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!channel?.isTextBased()) continue;
    try {
      const webhook = await getTranslationWebhook(channel);
      await webhook.deleteMessage(row.message_id);
    } catch {}
  }
  await pool.query("DELETE FROM translation_groups WHERE group_id = $1", [groupId]);
}

async function updateReactionSummaries(groupId) {
  const summary = await reactionSummary(groupId);
  const copies = await pool.query(
    "SELECT * FROM translation_messages WHERE group_id = $1 AND is_source = FALSE",
    [groupId]
  );
  for (const row of copies.rows) {
    await editTranslatedCopy(row, `${row.base_content || ""}${summary}`).catch(error => {
      console.error("❌ Reaction summary update:", error.message);
    });
  }
}

// =====================================================
// SOCIAL TRANSLATION — REACT 🌐 TO TRANSLATE
// =====================================================

const SOCIAL_TRANSLATE_EMOJI = "🌐";
const SOCIAL_TRANSLATION_DELETE_MS = 30_000;

function isReactionTranslateChannel(channel) {
  if (!channel?.isTextBased?.()) return false;

  const automaticLanguageChannel = Object.values(LANGUAGE_CHANNELS)
    .some(info => info.channel === channel.id);

  if (automaticLanguageChannel) return false;

  return (
    SOCIAL_CHANNELS.has(channel.id) ||
    channel.parentId === SOCIAL_CATEGORY_ID ||
    channel.parentId === IMPORTANT_CATEGORY_ID ||
    channel.id === CHANNELS.REMINDERS ||
    channel.id === CHANNELS.HIGHLIGHTS ||
    channel.id === CHANNELS.EVENT_BOARD ||
    channel.parentId === WELCOME_CATEGORY_ID ||
    EXTRA_REACTION_TRANSLATION_CHANNELS.has(channel.id)
  );
}

async function cleanupLegacySocialCompanions() {
  const result = await pool.query(
    "SELECT channel_id, companion_message_id FROM social_companions"
  );

  let removed = 0;

  for (const row of result.rows) {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!channel?.isTextBased()) continue;

    const companion = await channel.messages.fetch(row.companion_message_id).catch(() => null);
    if (!companion) continue;

    await companion.delete().catch(() => {});
    removed++;
  }

  await pool.query("DELETE FROM social_companions");

  if (result.rows.length) {
    console.log(`🧹 Removed ${removed} legacy Social Translate companion message(s).`);
  }
}

async function removeSocialTranslationReaction(reaction, userId) {
  const guild = reaction.message.guild;
  const me = guild?.members?.me || (guild ? await guild.members.fetchMe().catch(() => null) : null);
  const canManageMessages = me
    ? reaction.message.channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)
    : false;

  if (!canManageMessages) return;
  await reaction.users.remove(userId).catch(() => {});
}

async function sendTemporarySocialNotice(message, content, deleteAfterMs = 10_000) {
  const notice = await message.reply({
    content,
    allowedMentions: { parse: [], repliedUser: false }
  }).catch(() => null);

  if (!notice) return;

  setTimeout(() => {
    void notice.delete().catch(() => {});
  }, deleteAfterMs);
}

async function handleSocialTranslationReaction(reaction, user) {
  let message = reaction.message;

  try {
    message = await message.fetch();
  } catch {}

  if (!message?.guild) return false;
  if (!isReactionTranslateChannel(message.channel)) return false;
  if (emojiKey(reaction.emoji) !== SOCIAL_TRANSLATE_EMOJI) return false;

  console.log(`🌐 Translation requested in #${message.channel.name} by ${user.tag}`);

  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return true;

  const me = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
  const perms = me ? message.channel.permissionsFor(me) : null;
  const canSendHere = !!perms?.has(PermissionFlagsBits.SendMessages);

  await removeSocialTranslationReaction(reaction, user.id);

  if (!message.content || !hasTranslatableText(message.content)) {
    if (canSendHere) {
      await sendTemporarySocialNotice(
        message,
        "🌐 Vestra can only translate messages that contain text."
      );
    } else {
      await user.send("🌐 Vestra can only translate messages that contain text.").catch(() => {});
    }
    return true;
  }

  const targetKey = await inferPrimaryLanguage(member);
  const target = LANGUAGE_CHANNELS[targetKey];

  let translated;
  try {
    translated = await googleTranslate(message.content, target.code, null);
  } catch (error) {
    console.error("❌ Reaction translation:", error.message);

    const failureText = "🌐 Translation is temporarily unavailable. Please try again.";

    if (canSendHere) {
      await sendTemporarySocialNotice(message, failureText);
    } else {
      await user.send(failureText).catch(() => {});
    }

    return true;
  }

  const originalComparable = (message.content || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();

  const translatedComparable = (translated || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();

  if (originalComparable && originalComparable === translatedComparable) {
    const sameLanguageText = `${target.emoji} This message already appears to be in **${target.name}**.`;

    if (canSendHere) {
      await sendTemporarySocialNotice(message, sameLanguageText, 10_000);
    } else {
      await user.send(sameLanguageText).catch(() => {});
    }

    return true;
  }

  const requesterName = safeDisplayName(member, user);
  const deleteAtUnix = Math.floor(
    (Date.now() + SOCIAL_TRANSLATION_DELETE_MS) / 1000
  );

  const makeTranslationEmbed = temporary => {
    const translationEmbed = new EmbedBuilder()
      .setAuthor({
        name: safeDisplayName(message.member, message.author),
        iconURL: message.author?.displayAvatarURL?.({ size: 128 }) || undefined
      })
      .setTitle(`${target.emoji} Translation → ${target.name}`)
      .setDescription(limitText(translated, 3900));

    if (temporary) {
      translationEmbed.addFields({
        name: "⏳ Translation disappears",
        value: `<t:${deleteAtUnix}:R> • <t:${deleteAtUnix}:T>`
      });
    }

    return translationEmbed.setFooter({
      text: temporary
        ? `Requested by ${requesterName} • Vestra`
        : `Requested by ${requesterName} • Vestra • DM fallback`
    });
  };

  let translatedReply = null;

  if (canSendHere) {
    translatedReply = await message.reply({
      embeds: [makeTranslationEmbed(true)],
      allowedMentions: { parse: [], repliedUser: false }
    }).catch(error => {
      console.error(`❌ Reaction translation reply in #${message.channel.name}:`, error.message);
      return null;
    });
  }

  if (!translatedReply) {
    console.warn(`⚠️ Could not reply in #${message.channel.name}; sending translation by DM instead.`);

    await user.send({
      content: `🌐 **Translation from #${message.channel.name}**\n${message.url}`,
      embeds: [makeTranslationEmbed(false)]
    }).catch(error => {
      console.error("❌ Translation DM fallback:", error.message);
    });

    return true;
  }

  setTimeout(() => {
    void translatedReply.delete().catch(() => {});
  }, SOCIAL_TRANSLATION_DELETE_MS);

  return true;
}

// =====================================================
// COMMUNITY HIGHLIGHTS / STARBOARD
// =====================================================

function reactionStringFromMessage(message) {
  const entries = [...message.reactions.cache.values()]
    .map(reaction => ({ emoji: emojiKey(reaction.emoji), count: reaction.count || 0 }))
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count);
  return entries.map(x => `${x.emoji} ${x.count}`).join("   ");
}

async function upsertHighlight(sourceMessage, score, reactionText = "") {
  if (!sourceMessage || sourceMessage.author?.bot) return;
  if (sourceMessage.channel.id === CHANNELS.HIGHLIGHTS) return;

  const highlightChannel = await client.channels.fetch(CHANNELS.HIGHLIGHTS).catch(() => null);
  if (!highlightChannel?.isTextBased()) return;

  const existing = await pool.query(
    "SELECT * FROM highlights WHERE source_message_id = $1",
    [sourceMessage.id]
  );

  const firstImage = [...sourceMessage.attachments.values()].find(a => a.contentType?.startsWith("image/"));
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle("✦ ASHEN HIGHLIGHT")
    .setAuthor({
      name: safeDisplayName(sourceMessage.member, sourceMessage.author),
      iconURL: sourceMessage.author.displayAvatarURL({ size: 128 })
    })
    .setDescription(limitText(sourceMessage.content || "*(attachment / media post)*", 3500))
    .addFields(
      { name: "♡ COMMUNITY LOVE", value: reactionText || `${score} reactions`, inline: true },
      { name: "↗ VIEW ORIGINAL", value: `[Jump to message](${sourceMessage.url})`, inline: true }
    )
    .setFooter({ text: "Vestra • Chosen by the Ashen community" })
    .setTimestamp(sourceMessage.createdAt);

  if (firstImage) embed.setImage(firstImage.url);

  if (existing.rows[0]) {
    const highlight = await highlightChannel.messages.fetch(existing.rows[0].highlight_message_id).catch(() => null);
    if (highlight) {
      await highlight.edit({ embeds: [embed] }).catch(() => {});
      await pool.query("UPDATE highlights SET score = $2 WHERE source_message_id = $1", [sourceMessage.id, score]);
      return;
    }
  }

  const sent = await highlightChannel.send({ embeds: [embed] });
  await pool.query(
    `INSERT INTO highlights(source_message_id, highlight_message_id, source_channel_id, score)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(source_message_id) DO UPDATE SET highlight_message_id = EXCLUDED.highlight_message_id, score = EXCLUDED.score`,
    [sourceMessage.id, sent.id, sourceMessage.channel.id, score]
  );
}

async function removeHighlight(sourceMessageId) {
  const result = await pool.query("SELECT * FROM highlights WHERE source_message_id = $1", [sourceMessageId]);
  const row = result.rows[0];
  if (!row) return;
  const channel = await client.channels.fetch(CHANNELS.HIGHLIGHTS).catch(() => null);
  if (channel?.isTextBased()) {
    const message = await channel.messages.fetch(row.highlight_message_id).catch(() => null);
    if (message) await message.delete().catch(() => {});
  }
  await pool.query("DELETE FROM highlights WHERE source_message_id = $1", [sourceMessageId]);
}

async function maybeHighlightGroup(groupId) {
  const reactions = await pool.query(
    `SELECT emoji_key, COUNT(DISTINCT user_id)::int AS count
     FROM message_reactions
     WHERE group_id = $1
     GROUP BY emoji_key
     ORDER BY count DESC, emoji_key ASC`,
    [groupId]
  );

  const total = reactions.rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  if (total < HIGHLIGHT_REACTION_THRESHOLD) return;

  const reactionText = reactions.rows.map(row => `${row.emoji_key} ${row.count}`).join("   ");
  const group = await pool.query("SELECT * FROM translation_groups WHERE group_id = $1", [groupId]);
  const row = group.rows[0];
  if (!row) return;
  const channel = await client.channels.fetch(row.source_channel_id).catch(() => null);
  if (!channel?.isTextBased()) return;
  const source = await channel.messages.fetch(row.source_message_id).catch(() => null);
  if (!source) return;
  await upsertHighlight(source, total, reactionText);
}

async function maybeHighlightNative(message) {
  if (!message || message.author?.bot) return;
  const total = [...message.reactions.cache.values()].reduce((sum, r) => sum + (r.count || 0), 0);
  if (total < HIGHLIGHT_REACTION_THRESHOLD) return;
  await upsertHighlight(message, total, reactionStringFromMessage(message));
}

// =====================================================
// DAYLIGHT SAVING + SCHEDULES
// =====================================================

function nthWeekdayOfMonth(year, monthIndex, weekday, nth) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const firstWeekday = first.getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  return 1 + offset + (nth - 1) * 7;
}

function isCentralDSTDate(year, month, day) {
  // U.S. DST: second Sunday in March through first Sunday in November.
  const marchSecondSunday = nthWeekdayOfMonth(year, 2, 0, 2);
  const novemberFirstSunday = nthWeekdayOfMonth(year, 10, 0, 1);
  if (month < 3 || month > 11) return false;
  if (month > 3 && month < 11) return true;
  if (month === 3) return day >= marchSecondSunday;
  if (month === 11) return day < novemberFirstSunday;
  return false;
}

function chicagoParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const values = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    weekday: weekdayMap[values.weekday],
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function dateKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function isNexusSunday(year, month, day) {
  const anchor = Date.UTC(2026, 10, 8);
  const current = Date.UTC(year, month - 1, day);
  const days = Math.floor((current - anchor) / 86400000);
  return days >= 0 && days % 14 === 0;
}

const SCHEDULED_EVENTS = [
  {
    key: "reset",
    label: "Reset",
    role: REMINDERS.reset.role,
    days: [0,1,2,3,4,5,6],
    winter: [7,0],
    summer: [8,0],
    text: "🔄 Reset reminder!"
  },
  {
    key: "morning",
    label: "Morning Conquest",
    role: REMINDERS.morning.role,
    days: [0,1,2,3,4,5,6],
    winter: [10,30],
    summer: [11,30],
    text: "🌅 Morning Conquest is starting now!"
  },
  {
    key: "night",
    label: "Night Conquest",
    role: REMINDERS.night.role,
    days: [0,1,2,3,4,5,6],
    winter: [18,30],
    summer: [20,30],
    text: "🌌 Night Conquest is starting now!"
  },
  {
    key: "opening",
    label: "Clash Opening Call",
    role: REMINDERS.opening.role,
    days: [1,3,5],
    winter: [9,0],
    summer: [10,0],
    text: "🔔 Clash Opening Call!"
  },
  {
    key: "battle",
    label: "Clash Battle Call",
    role: REMINDERS.battle.role,
    days: [1,3,5],
    winter: [15,0],
    summer: [16,0],
    text: "⚔️ Clash Battle Call!"
  },
  {
    key: "final",
    label: "Clash Final Call",
    role: REMINDERS.final.role,
    days: [1,3,5],
    winter: [20,30],
    summer: [21,30],
    text: "🚨 Clash Final Call!"
  },
  {
    key: "registration",
    label: "Guild Clash Registration",
    role: REMINDERS.registration.role,
    days: [0,2,4],
    winter: [8,30],
    summer: [9,30],
    text: "⏰ Guild Clash Registration is open!"
  },
  {
    key: "server_tournament_start",
    label: "Server Tournament",
    role: TOURNAMENTS.sever.role,
    days: [6],
    winter: [14,0],
    summer: [15,0],
    text: "⚔️ Server Tournament has started! The tournament battle is now underway. Keep an eye on the Live Event Board for voting rounds.",
    tournament: "sever",
    kind: "tournament_start"
  },
  {
    key: "nexus_tournament_start",
    label: "Nexus Tournament",
    role: TOURNAMENTS.nexus.role,
    days: [0],
    winter: [15,0],
    summer: [16,0],
    text: "🌀 Nexus Tournament has started! The tournament battle is now underway. Keep an eye on the Live Event Board for voting rounds.",
    tournament: "nexus",
    kind: "tournament_start",
    alternateSunday: true
  }
];

function eventTimeForDate(event, y, m, d) {
  return isCentralDSTDate(y, m, d) ? event.summer : event.winter;
}

function eventApplies(event, y, m, d, weekday) {
  if (!event.days.includes(weekday)) return false;
  if (event.alternateSunday && !isNexusSunday(y, m, d)) return false;
  return true;
}

// =====================================================
// LOCALIZED NOTIFICATION DELIVERY
// =====================================================

async function sendMasterLog(roleId, label, text, deliveredCount) {
  const channel = await client.channels.fetch(CHANNELS.REMINDERS).catch(() => null);
  if (!channel?.isTextBased()) throw new Error("#guild-pings is unavailable");

  const embed = brandEmbed(
    `🔔 ${label}`,
    text || "Event notification sent."
  )
    .addFields(
      {
        name: "🌎 Localized Delivery",
        value: `${deliveredCount} member${deliveredCount === 1 ? "" : "s"} notified in their primary-language General channel.`,
        inline: false
      },
      {
        name: "🎯 Subscriber Role",
        value: roleId ? `<@&${roleId}>` : "No role",
        inline: false
      }
    )
    .setFooter({ text: "Vestra • Guild Ping Log • This message does not ping members" })
    .setTimestamp();

  await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] }
  });
}

async function ensureLanguageAccess(member, languageKey) {
  const info = LANGUAGE_CHANNELS[languageKey];
  if (!info) return false;

  if (!member.roles.cache.has(info.role)) {
    try {
      await member.roles.add(info.role);
    } catch (error) {
      console.error(
        `⚠️ Could not add ${info.name} access to ${member.user.tag}:`,
        error.message
      );
    }
  }

  const channel = await client.channels.fetch(info.channel).catch(() => null);
  if (!channel?.isTextBased()) return false;

  return !!channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel);
}

async function sendLocalizedRoleNotification(roleId, englishText, label) {
  const guild = getGuild();
  if (!guild) return 0;

  await guild.members.fetch();

  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) {
    console.error(`❌ ${label}: role ${roleId} could not be found.`);
    await sendMasterLog(roleId, label, englishText, 0);
    return 0;
  }

  const members = role.members.filter(member => !member.user.bot);
  const ids = [...members.keys()];
  const prefs = await loadPrimaryLanguageMap(ids);
  const grouped = new Map(LANGUAGE_KEYS.map(key => [key, []]));

  for (const member of members.values()) {
    const languageKey = inferPrimaryFromRoles(member, prefs);
    grouped.get(languageKey)?.push(member);
  }

  let delivered = 0;

  for (const [languageKey, recipients] of grouped.entries()) {
    if (!recipients.length) continue;

    const info = LANGUAGE_CHANNELS[languageKey];
    const channel = await client.channels.fetch(info.channel).catch(() => null);
    if (!channel?.isTextBased()) {
      console.error(`❌ ${label}: ${info.name} General channel unavailable.`);
      continue;
    }

    const reachable = [];

    for (const member of recipients) {
      const canView = await ensureLanguageAccess(member, languageKey);
      if (canView) reachable.push(member);
      else {
        console.error(
          `⚠️ ${label}: ${member.user.tag} cannot view ${info.name} General.`
        );
      }
    }

    if (!reachable.length) continue;

    let localized = englishText;

    if (languageKey !== "english") {
      try {
        localized = await googleTranslate(englishText, info.code, "en");
      } catch (error) {
        console.error(
          `⚠️ Notification translation fallback (${languageKey}):`,
          error.message
        );
      }
    }

    for (const group of chunks(reachable, 40)) {
      const userIds = group.map(member => member.id);
      const mentions = userIds.map(id => `<@${id}>`).join(" ");

      await channel.send({
        content: `${mentions}
${localized}`,
        allowedMentions: {
          parse: [],
          users: userIds
        }
      });

      delivered += userIds.length;
    }
  }

  console.log(
    `📣 ${label}: ${members.size} subscriber(s), ${delivered} localized delivery/deliveries.`
  );

  await sendMasterLog(roleId, label, englishText, delivered);
  return delivered;
}

// =====================================================
// TOURNAMENT STATE + LIVE EVENT BOARD
// =====================================================

async function getActiveTournamentState() {
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

async function startTournamentEvent(tournamentKey, announcementText, label) {
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

async function startTournamentVote(tournamentKey, round, pingMembers = true) {
  const tournament = TOURNAMENTS[tournamentKey];
  const parts = chicagoParts();
  const ends = new Date(Date.now() + tournament.voteMinutes * 60 * 1000);
  await setTournamentState(tournamentKey, dateKey(parts), round, "voting", ends);

  if (pingMembers) {
    await sendLocalizedRoleNotification(
      tournament.role,
      `🗳️ ${tournament.name} Round ${round} voting is OPEN! You have ${tournament.voteMinutes} minutes to vote.`,
      `${tournament.name} — Round ${round} Voting Open`
    );
  }

  await updateEventBoard();
}

async function closeTournamentVote(state) {
  const tournament = TOURNAMENTS[state.tournament];
  const phase = state.round >= tournament.rounds ? "final_battle" : "battle";
  await setTournamentState(state.tournament, state.active_date, state.round, phase, null);
  await updateEventBoard();
}

async function finishTournament(tournamentKey) {
  const parts = chicagoParts();
  await setTournamentState(tournamentKey, dateKey(parts), 0, "complete", null);
  await updateEventBoard();
}

function format12Hour(hour, minute) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function upcomingEvents(limit = 6) {
  const now = chicagoParts();
  const nowMinutes = now.hour * 60 + now.minute;
  const candidates = [];

  for (let offset = 0; offset <= 14; offset++) {
    const calendar = new Date(
      Date.UTC(now.year, now.month - 1, now.day + offset, 12)
    );

    const y = calendar.getUTCFullYear();
    const m = calendar.getUTCMonth() + 1;
    const d = calendar.getUTCDate();
    const weekday = calendar.getUTCDay();

    for (const event of SCHEDULED_EVENTS) {
      if (!eventApplies(event, y, m, d, weekday)) continue;

      const [hour, minute] = eventTimeForDate(event, y, m, d);
      const relativeMinutes =
        offset * 1440 +
        (hour * 60 + minute) -
        nowMinutes;

      if (relativeMinutes < 0) continue;

      candidates.push({
        ...event,
        y,
        m,
        d,
        weekday,
        hour,
        minute,
        offset,
        relativeMinutes
      });
    }
  }

  return candidates
    .sort((a, b) => a.relativeMinutes - b.relativeMinutes)
    .slice(0, limit);
}

function eventDayLabel(event) {
  if (event.offset === 0) return "Today";
  if (event.offset === 1) return "Tomorrow";

  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  }).format(
    new Date(Date.UTC(event.y, event.m - 1, event.d, 12))
  );
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

  const mode = isCentralDSTDate(
    now.year,
    now.month,
    now.day
  )
    ? "Summer / DST schedule"
    : "Winter / Standard schedule";

  const nextEmbed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor({
      name: "🖤 ASHEN LIVE EVENT BOARD"
    })
    .setTitle("⏳ NEXT EVENT")
    .setDescription(
      next
        ? `# ${next.label.toUpperCase()}

## ${eventDayLabel(next)} • ${format12Hour(next.hour, next.minute)}

# ⏱️ ${countdownText(next.relativeMinutes)} LEFT

**This is the very next scheduled Ashen event.**`
        : "# No upcoming events found."
    )
    .setFooter({
      text: "Vestra • Live Event Board • Next Event"
    })
    .setTimestamp();

  const followingEmbed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle("📅 FOLLOWING EVENTS")
    .setDescription(
      future.length
        ? future
            .map(
              event =>
                `**${event.label}**
${eventDayLabel(event)} • ${format12Hour(event.hour, event.minute)}
⏳ ${countdownText(event.relativeMinutes)}`
            )
            .join("\n\n")
        : "Nothing else is currently scheduled."
    )
    .addFields({
      name: "🕒 CURRENT GAME SCHEDULE",
      value: mode
    })
    .setFooter({
      text: "Vestra • Live Event Board • Coming Up"
    });

  return [nextEmbed, followingEmbed];
}

async function eventBoardPayload() {
  const state = await getActiveTournamentState();

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("settings_open")
        .setLabel("My Settings")
        .setEmoji("✨")
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId("settings_card")
        .setLabel("My Vestra Card")
        .setEmoji("👤")
        .setStyle(ButtonStyle.Secondary)
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
      ? `${tournament.emoji} ${tournament.name} — Round ${state.round}/${tournament.rounds}`
      : `${tournament.emoji} ${tournament.name} — LIVE`;

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor({
      name: "🏆 ASHEN TOURNAMENT MODE"
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
        `# 🟢 VOTING OPEN

## ROUND ${state.round} / ${tournament.rounds}

**Cast your vote now.**
Voting closes <t:${unix}:R>.`
      )
      .addFields(
        {
          name: "⏳ Voting Window",
          value: `<t:${unix}:R> • closes at <t:${unix}:t>`
        },
        {
          name: "⚔️ What Happens Next?",
          value: "When voting closes, Vestra switches the board back to **Battle in Progress**. Staff will manually open the next vote when the battle actually ends."
        }
      );
  } else if (state.phase === "battle") {
    const nextRound = state.round + 1;

    embed
      .setDescription(
        state.round === 0
          ? `# 🔴 BATTLE IN PROGRESS

## ${tournament.name.toUpperCase()} IS LIVE

The tournament battle is underway.
Ashen staff will manually open **Vote 1** when the battle is ready.`
          : `# 🔴 BATTLE IN PROGRESS

## ROUND ${state.round} COMPLETE

Voting is closed while the battle plays out.
The next voting round will open manually when the battle is ready.`
      )
      .addFields({
        name: "🗳️ Next Vote",
        value: `Staff will manually open **Round ${nextRound}** when the battle is ready.`
      });

    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("tournament_next")
          .setLabel(`Start Vote ${nextRound}`)
          .setEmoji("🗳️")
          .setStyle(ButtonStyle.Success)
      )
    );
  } else if (state.phase === "final_battle") {
    embed
      .setDescription(
        `# 🏁 FINAL BATTLE

## ALL 4 VOTING ROUNDS COMPLETE

The last battle is underway.
When it ends, staff can close Tournament Mode and return to the normal event board.`
      )
      .addFields({
        name: "🏁 Finish",
        value: "When the final battle ends, staff can finish Tournament Mode and return the board to the normal upcoming-event view."
      });

    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("tournament_finish")
          .setLabel("Finish Tournament")
          .setEmoji("🏁")
          .setStyle(ButtonStyle.Primary)
      )
    );
  }

  return {
    embeds: [embed],
    components: rows
  };
}

async function setupEventBoard() {
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

async function updateEventBoard() {
  const channel = await client.channels.fetch(CHANNELS.EVENT_BOARD).catch(() => null);
  if (!channel?.isTextBased()) return;
  const state = await dbGetState("event_board_message");
  let message = state?.messageId ? await channel.messages.fetch(state.messageId).catch(() => null) : null;
  if (!message) return setupEventBoard();
  await message.edit(await eventBoardPayload()).catch(error => console.error("❌ Event Board update:", error.message));
}

// =====================================================
// SCHEDULER
// =====================================================

let schedulerRunning = false;

async function wasEventSent(key) {
  const result = await pool.query("SELECT 1 FROM sent_events WHERE event_key = $1", [key]);
  return !!result.rows[0];
}

async function markEventSent(key) {
  await pool.query("INSERT INTO sent_events(event_key) VALUES($1) ON CONFLICT(event_key) DO NOTHING", [key]);
}

async function processScheduledEvent(event, parts) {
  const persistentKey = `${dateKey(parts)}:${event.key}`;
  if (await wasEventSent(persistentKey)) return;

  if (event.kind === "tournament_start") {
    await startTournamentEvent(
      event.tournament,
      event.text,
      event.label
    );
  } else {
    await sendLocalizedRoleNotification(
      event.role,
      event.text,
      event.label
    );
  }

  await markEventSent(persistentKey);
}

async function checkSchedule() {
  if (schedulerRunning) return;
  schedulerRunning = true;

  try {
    const now = chicagoParts();
    const currentMinutes = now.hour * 60 + now.minute;

    for (const event of SCHEDULED_EVENTS) {
      if (!eventApplies(event, now.year, now.month, now.day, now.weekday)) continue;
      const [hour, minute] = eventTimeForDate(event, now.year, now.month, now.day);
      const late = currentMinutes - (hour * 60 + minute);
      if (late < 0 || late > 3) continue;
      try {
        await processScheduledEvent(event, now);
      } catch (error) {
        console.error(`❌ Scheduled event error (${event.key}):`, error);
      }
    }

    const active = await getActiveTournamentState();
    if (active?.phase === "voting" && active.vote_ends_at && new Date(active.vote_ends_at).getTime() <= Date.now()) {
      await closeTournamentVote(active);
    }
  } finally {
    schedulerRunning = false;
  }
}

function startScheduler() {
  console.log("✅ Persistent DST-aware scheduler active.");
  void checkSchedule();
  setInterval(() => void checkSchedule(), 20_000);
  setInterval(() => void updateEventBoard(), 60_000);
}

// =====================================================
// EMERGENCY CATEGORY RECOVERY
// =====================================================

async function recoverAshenMainCategories(guildOverride = null) {
  const guild = await resolveAshenGuild(guildOverride);
  const report = { recreated: [], moved: [], failed: [] };

  if (!guild) {
    report.failed.push("Ashen Warriors guild unavailable");
    return report;
  }

  await guild.channels.fetch().catch(() => {});

  const categoryById = id => {
    const channel = guild.channels.cache.get(id);
    return channel?.type === ChannelType.GuildCategory ? channel : null;
  };

  const categoryByName = needles =>
    guild.channels.cache.find(channel => {
      if (channel.type !== ChannelType.GuildCategory) return false;
      const name = channel.name.toUpperCase();
      return needles.some(needle => name.includes(needle.toUpperCase()));
    }) || null;

  const createCategory = async name => {
    try {
      const category = await guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
        reason: "Recover accidentally deleted Ashen category"
      });

      report.recreated.push(name);
      console.log(`🛟 Recreated category ${name}`);
      return category;
    } catch (error) {
      report.failed.push(`Could not recreate ${name}: ${error.message}`);
      return null;
    }
  };

  const moveKnownChannel = async (channel, category) => {
    if (!channel || !category) return;

    if (channel.parentId === category.id) return;

    try {
      await channel.setParent(category.id, {
        lockPermissions: false,
        reason: "Recover channel after deleted Ashen category"
      });
      report.moved.push(channel.name);
    } catch (error) {
      report.failed.push(
        `Could not restore ${channel.name} to ${category.name}: ${error.message}`
      );
    }
  };

  const byId = id => guild.channels.cache.get(id) || null;

  // WELCOME
  let welcome =
    categoryById(WELCOME_CATEGORY_ID) ||
    categoryByName(["WELCOME TO ASHEN"]);

  if (!welcome) {
    welcome = await createCategory("╭━━ 𖤐 WELCOME TO ASHEN 𖤐 ━━╮");
  }

  if (welcome) {
    WELCOME_CATEGORY_ID = welcome.id;

    for (const id of [
      CHANNELS.START_HERE,
      CHANNELS.RULES,
      CHANNELS.ONBOARDING,
      CHANNELS.HELP,
      CHANNELS.STAFF_REQUESTS,
      CHANNELS.INTRODUCTIONS,
      CHANNELS.PREFERENCES
    ]) {
      await moveKnownChannel(byId(id), welcome);
    }

    const guildMembers = guild.channels.cache.find(
      ch =>
        ch.isTextBased?.() &&
        (ch.name.includes("ashen-members") || ch.name.includes("guild-members"))
    ) || null;

    await moveKnownChannel(guildMembers, welcome);
  }

  // ASHEN INFO
  let info =
    categoryById(IMPORTANT_CATEGORY_ID) ||
    categoryByName(["ASHEN INFO"]);

  if (!info) {
    info = await createCategory("╭━━ ✦ ASHEN INFO ✦ ━━╮");
  }

  if (info) {
    IMPORTANT_CATEGORY_ID = info.id;

    for (const id of [
      CHANNELS.REMINDERS,
      CHANNELS.HIGHLIGHTS,
      CHANNELS.EVENT_BOARD
    ]) {
      await moveKnownChannel(byId(id), info);
    }

    for (const channel of guild.channels.cache.values()) {
      if (!channel.isTextBased?.()) continue;
      const name = channel.name.toLowerCase();

      if (
        name.includes("admin-announcements") ||
        name.includes("ashen-announcements") ||
        name.includes("game-announcements") ||
        name.includes("sxs-announcements")
      ) {
        await moveKnownChannel(channel, info);
      }
    }
  }

  // SWORD X STAFF
  let sxs = categoryByName(["SWORD X STAFF", "SWORD X", "SXS"]);

  if (!sxs) {
    sxs = await createCategory("╭━━ ⚔ SWORD X STAFF ⚔ ━━╮");
  }

  if (sxs) {
    for (const language of Object.values(LANGUAGE_CHANNELS)) {
      await moveKnownChannel(byId(language.channel), sxs);
    }

    await moveKnownChannel(byId("1507566115994472568"), sxs);
    await moveKnownChannel(byId("1538251460351889599"), sxs);

    const sxsEventBoard = guild.channels.cache.find(
      ch =>
        ch.isTextBased?.() &&
        ch.name.includes("sxs-event-board")
    ) || null;

    await moveKnownChannel(sxsEventBoard, sxs);
  }

  // ASHEN SOCIAL
  let social =
    categoryById(SOCIAL_CATEGORY_ID) ||
    categoryByName(["ASHEN SOCIAL"]);

  if (!social) {
    social = await createCategory("╭━━ ♡ ASHEN SOCIAL ♡ ━━╮");
  }

  if (social) {
    SOCIAL_CATEGORY_ID = social.id;

    for (const id of SOCIAL_CHANNELS) {
      await moveKnownChannel(byId(id), social);
    }
  }

  // ASHEN VOICE
  let voice = categoryByName(["ASHEN VOICE", "VOICE CALLS"]);

  if (!voice) {
    voice = await createCategory("╭━━ 𖤐 ASHEN VOICE 𖤐 ━━╮");
  }

  if (voice) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildVoice) continue;

      const name = channel.name.toLowerCase();

      if (
        name === "general" ||
        name.includes("gaming") ||
        name.includes("boss grinds") ||
        name.includes("admins")
      ) {
        await moveKnownChannel(channel, voice);
      }
    }
  }

  if (report.recreated.length || report.moved.length) {
    console.log(
      `🛟 Recovery complete: ${report.recreated.length} categories recreated, ${report.moved.length} channels restored.`
    );
  }

  return report;
}

// =====================================================
// ASHEN SIDEBAR THEME
// =====================================================

async function applyAshenSidebarTheme(guildOverride = null) {
  const guild = await resolveAshenGuild(guildOverride);

  if (guild) {
    await recoverAshenMainCategories(guild).catch(error => {
      console.error("⚠️ Ashen category recovery:", error.message);
    });
  }

  const report = {
    guildName: guild?.name || null,
    guildId: guild?.id || null,
    renamed: [],
    created: [],
    removed: [],
    skipped: [],
    failed: []
  };

  if (!guild) {
    report.failed.push("Guild unavailable");
    return report;
  }

  await guild.channels.fetch().catch(() => {});

  const byId = id => guild.channels.cache.get(id) || null;

  const findCategory = (...needles) =>
    guild.channels.cache.find(channel => {
      if (channel.type !== ChannelType.GuildCategory) return false;
      const name = channel.name.toUpperCase();
      return needles.some(needle =>
        name.includes(needle.toUpperCase())
      );
    }) || null;

  const findTextByNames = (...needles) =>
    guild.channels.cache.find(channel => {
      if (!channel.isTextBased?.()) return false;
      const name = channel.name.toLowerCase();
      return needles.some(needle =>
        name.includes(needle.toLowerCase())
      );
    }) || null;

  const findVoiceByNames = (...needles) =>
    guild.channels.cache.find(channel => {
      if (channel.type !== ChannelType.GuildVoice) return false;
      const name = channel.name.toLowerCase();
      return needles.some(needle =>
        name.includes(needle.toLowerCase())
      );
    }) || null;

  const renameChannel = async (
    channel,
    desiredName,
    { optional = false } = {}
  ) => {
    if (!channel) {
      if (!optional) {
        report.failed.push(
          `Missing channel/category for ${desiredName}`
        );
      }
      return;
    }

    if (channel.name === desiredName) {
      report.skipped.push(desiredName);
      return;
    }

    const oldName = channel.name;

    try {
      await channel.edit({
        name: desiredName,
        reason: "Ashen black-and-white celestial sidebar theme"
      });

      report.renamed.push(
        `${oldName} → ${desiredName}`
      );
    } catch (error) {
      report.failed.push(
        `${oldName} → ${desiredName}: ${error.message}`
      );
    }
  };

  const moveChannel = async (channel, category) => {
    if (!channel || !category) return;

    if (channel.parentId === category.id) return;

    try {
      await channel.setParent(category.id, {
        lockPermissions: false,
        reason: "Ashen celestial sidebar grouping"
      });
    } catch (error) {
      report.failed.push(
        `Could not move ${channel.name} under ${category.name}: ${error.message}`
      );
    }
  };

  const dashCount = name =>
    (String(name || "").match(/━/gu) || []).length;

  const isOldDecorativePiece = channel => {
    if (
      channel.type !== ChannelType.GuildCategory &&
      channel.type !== ChannelType.GuildText
    ) {
      return false;
    }

    const name = channel.name || "";
    const hasWords = /[\p{L}\p{N}]/u.test(name);

    return (
      !hasWords &&
      (
        dashCount(name) >= 3 ||
        /^╰/u.test(name) ||
        /^━━━━/u.test(name)
      )
    );
  };

  // Delete every old Vestra-only decoration first.
  // Main title categories contain words, so they are never matched here.
  const oldDecorations = guild.channels.cache.filter(
    isOldDecorativePiece
  );

  for (const decoration of oldDecorations.values()) {
    try {
      if (decoration.type === ChannelType.GuildCategory) {
        const children = guild.channels.cache.filter(
          ch => ch.parentId === decoration.id
        );

        for (const child of children.values()) {
          await child.setParent(null, {
            lockPermissions: false,
            reason: "Clean old Ashen decorative category"
          }).catch(() => {});
        }
      }

      const oldName = decoration.name;
      await decoration.delete(
        "Remove obsolete Ashen decorative design"
      );
      report.removed.push(oldName);
    } catch (error) {
      report.failed.push(
        `Could not remove old decoration ${decoration.name}: ${error.message}`
      );
    }
  }

  await guild.channels.fetch().catch(() => {});

  // Resolve the five real top categories after cleanup.
  const welcomeCategory =
    byId(WELCOME_CATEGORY_ID) ||
    findCategory("WELCOME TO ASHEN");

  const infoCategory =
    byId(IMPORTANT_CATEGORY_ID) ||
    findCategory("ASHEN INFO");

  const socialCategory =
    byId(SOCIAL_CATEGORY_ID) ||
    findCategory("ASHEN SOCIAL");

  const sxsCategory =
    findCategory("SWORD X STAFF", "SWORD X", "SXS");

  const voiceCategory =
    findCategory("ASHEN VOICE", "VOICE CALLS");

  await renameChannel(
    welcomeCategory,
    "╭━━ 𖤐 WELCOME TO ASHEN 𖤐 ━━╮"
  );
  await renameChannel(
    infoCategory,
    "╭━━ ✦ ASHEN INFO ✦ ━━╮"
  );
  await renameChannel(
    sxsCategory,
    "╭━━ ⚔ SWORD X STAFF ⚔ ━━╮"
  );
  await renameChannel(
    socialCategory,
    "╭━━ ♡ ASHEN SOCIAL ♡ ━━╮"
  );
  await renameChannel(
    voiceCategory,
    "╭━━ 𖤐 ASHEN VOICE 𖤐 ━━╮"
  );

  // Rename known channels by ID.
  const directRenames = new Map([
    [CHANNELS.START_HERE, "⌂・start-here"],
    [CHANNELS.RULES, "♱・rules"],
    [CHANNELS.ONBOARDING, "✦・onboarding"],
    [CHANNELS.HELP, "♡・help-desk"],
    [CHANNELS.STAFF_REQUESTS, "⚔・staff-requests"],
    [CHANNELS.INTRODUCTIONS, "𖤐・introductions"],
    [CHANNELS.PREFERENCES, "◇・vestra-settings"],
    [CHANNELS.REMINDERS, "⌁・alert-history"],
    [CHANNELS.HIGHLIGHTS, "𖤐・community-highlights"],
    [CHANNELS.EVENT_BOARD, "◷・live-event-board"],
    [LANGUAGE_CHANNELS.english.channel, "◈・general-en"],
    [LANGUAGE_CHANNELS.spanish.channel, "◈・general-es"],
    [LANGUAGE_CHANNELS.french.channel, "◈・general-fr"],
    [LANGUAGE_CHANNELS.german.channel, "◈・general-de"],
    [LANGUAGE_CHANNELS.portuguese.channel, "◈・general-pt"],
    [LANGUAGE_CHANNELS.japanese.channel, "◈・general-ja"],
    ["1507566115994472568", "▣・sxs-media"],
    ["1538251460351889599", "▤・sxs-resources"],
    ["1542252582469247016", "☾・general"],
    ["1542252701578961028", "◇・movies-and-shows"],
    ["1542252734076690442", "♟・other-games"],
    ["1542252850808365226", "♢・food"],
    ["1542252884614184980", "⋆・random-topics"],
    ["1542252909222166628", "☠・memes"],
    ["1542253001824272454", "▣・media"],
    ["1542253232464601138", "♫・music"]
  ]);

  for (const [id, desiredName] of directRenames) {
    await renameChannel(
      byId(id),
      desiredName,
      { optional: true }
    );
  }

  // Optional channels are found globally so moving them under
  // a separator never makes the next theme pass think they vanished.
  const guildMembers = findTextByNames(
    "ashen-members",
    "guild-members"
  );

  await renameChannel(
    guildMembers,
    "♟・ashen-members",
    { optional: true }
  );

  const adminAnnouncements = findTextByNames(
    "ashen-announcements",
    "admin-announcements"
  );

  const sxsAnnouncements = findTextByNames(
    "sxs-announcements",
    "game-announcements"
  );

  await renameChannel(
    adminAnnouncements,
    "♱・ashen-announcements",
    { optional: true }
  );

  await renameChannel(
    sxsAnnouncements,
    "⚔・sxs-announcements",
    { optional: true }
  );

  const sxsEventBoard =
    guild.channels.cache.find(
      ch =>
        ch.isTextBased?.() &&
        ch.name.includes("sxs-event-board")
    ) ||
    guild.channels.cache.find(
      ch =>
        ch.isTextBased?.() &&
        ch.parentId === sxsCategory?.id &&
        ch.name.includes("event-board") &&
        !ch.name.includes("live-event-board")
    ) ||
    null;

  await renameChannel(
    sxsEventBoard,
    "◷・sxs-event-board",
    { optional: true }
  );

  const generalVoice = findVoiceByNames("general");
  const gamingVoice = findVoiceByNames("gaming");
  const bossVoice = findVoiceByNames(
    "boss grinds",
    "boss-grinds"
  );
  const adminsVoice = findVoiceByNames("admins");

  await renameChannel(
    generalVoice,
    "◌・General",
    { optional: true }
  );
  await renameChannel(
    gamingVoice,
    "⚔・Gaming",
    { optional: true }
  );
  await renameChannel(
    bossVoice,
    "♱・Boss Grinds",
    { optional: true }
  );
  await renameChannel(
    adminsVoice,
    "◇・Admins",
    { optional: true }
  );

  const createDecorationCategory = async name => {
    try {
      const category = await guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
        reason: "Ashen final decorative layout"
      });

      report.created.push(name);
      return category;
    } catch (error) {
      report.failed.push(
        `Could not create decoration ${name}: ${error.message}`
      );
      return null;
    }
  };

  const makeFooterName = (topName, symbol) => {
    const targetLength = Math.max(
      12,
      Array.from(topName).length
    );
    const center = ` ${symbol} `;
    const innerWidth = Math.max(
      8,
      targetLength - 2
    );
    const remaining = Math.max(
      4,
      innerWidth - Array.from(center).length
    );
    const left = Math.ceil(remaining / 2);
    const right = Math.floor(remaining / 2);

    return `╰${"━".repeat(left)}${center}${"━".repeat(right)}╯`;
  };

  const placeAfter = async (
    category,
    anchor,
    offset
  ) => {
    if (!category || !anchor) return;

    await category
      .setPosition(anchor.position + offset)
      .catch(() => {});
  };

  // Exactly ONE separator and ONE ending piece per section.
  // No other decorative categories are created.

  // WELCOME
  const welcomeSeparator = await createDecorationCategory(
    "━━━━ 𖤐 ━━━━"
  );
  const welcomeFooter = await createDecorationCategory(
    makeFooterName(
      "╭━━ 𖤐 WELCOME TO ASHEN 𖤐 ━━╮",
      "🖤"
    )
  );

  await moveChannel(
    byId(CHANNELS.PREFERENCES),
    welcomeSeparator
  );
  await moveChannel(
    guildMembers,
    welcomeSeparator
  );

  await placeAfter(
    welcomeSeparator,
    welcomeCategory,
    1
  );
  await placeAfter(
    welcomeFooter,
    welcomeSeparator,
    1
  );

  // INFO
  const infoSeparator = await createDecorationCategory(
    "━━━━ ✦ ━━━━"
  );
  const infoFooter = await createDecorationCategory(
    makeFooterName(
      "╭━━ ✦ ASHEN INFO ✦ ━━╮",
      "𖤐"
    )
  );

  for (const channel of [
    byId(CHANNELS.REMINDERS),
    byId(CHANNELS.HIGHLIGHTS),
    byId(CHANNELS.EVENT_BOARD)
  ]) {
    await moveChannel(channel, infoSeparator);
  }

  await placeAfter(
    infoSeparator,
    infoCategory,
    1
  );
  await placeAfter(
    infoFooter,
    infoSeparator,
    1
  );

  // SWORD X STAFF
  const sxsSeparator = await createDecorationCategory(
    "━━━━ ⚔ ━━━━"
  );
  const sxsFooter = await createDecorationCategory(
    makeFooterName(
      "╭━━ ⚔ SWORD X STAFF ⚔ ━━╮",
      "✦"
    )
  );

  for (const channel of [
    byId("1507566115994472568"),
    byId("1538251460351889599"),
    sxsEventBoard
  ]) {
    await moveChannel(channel, sxsSeparator);
  }

  await placeAfter(
    sxsSeparator,
    sxsCategory,
    1
  );
  await placeAfter(
    sxsFooter,
    sxsSeparator,
    1
  );

  // SOCIAL
  const socialSeparator = await createDecorationCategory(
    "━━━━ ♡ ━━━━"
  );
  const socialFooter = await createDecorationCategory(
    makeFooterName(
      "╭━━ ♡ ASHEN SOCIAL ♡ ━━╮",
      "☾"
    )
  );

  for (const id of [
    "1542252701578961028",
    "1542252734076690442",
    "1542252850808365226",
    "1542252884614184980",
    "1542252909222166628",
    "1542253001824272454",
    "1542253232464601138"
  ]) {
    await moveChannel(
      byId(id),
      socialSeparator
    );
  }

  await placeAfter(
    socialSeparator,
    socialCategory,
    1
  );
  await placeAfter(
    socialFooter,
    socialSeparator,
    1
  );

  // VOICE
  const voiceSecondaryChannels = [
    bossVoice,
    adminsVoice
  ].filter(Boolean);

  let voiceSeparator = null;

  if (voiceSecondaryChannels.length) {
    voiceSeparator = await createDecorationCategory(
      "━━━━ 𖤐 ━━━━"
    );

    for (const channel of voiceSecondaryChannels) {
      await moveChannel(
        channel,
        voiceSeparator
      );
    }

    await placeAfter(
      voiceSeparator,
      voiceCategory,
      1
    );
  }

  const voiceFooter = await createDecorationCategory(
    makeFooterName(
      "╭━━ 𖤐 ASHEN VOICE 𖤐 ━━╮",
      "♡"
    )
  );

  await placeAfter(
    voiceFooter,
    voiceSeparator || voiceCategory,
    1
  );

  console.log(
    `🖤 Ashen theme: ${report.removed.length} old decorations removed, ${report.created.length} final decorations created, ${report.failed.length} failed.`
  );

  return report;
}

// =====================================================
// PERMISSION CHECKS
// =====================================================

async function checkChannelPermissions(channelId, label, required) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.error(`❌ ${label}: Channel unavailable`);
    return;
  }
  const guild = channel.guild;
  const me = guild.members.me || await guild.members.fetchMe();
  const permissions = channel.permissionsFor(me);
  const missing = required.filter(permission => !permissions?.has(permission.flag)).map(permission => permission.name);
  if (missing.length) console.error(`❌ ${label}: Missing ${missing.join(", ")}`);
  else console.log(`✅ ${label}: Permissions OK`);
}

async function runPermissionChecks() {
  const basic = [
    { name: "View Channel", flag: PermissionFlagsBits.ViewChannel },
    { name: "Send Messages", flag: PermissionFlagsBits.SendMessages },
    { name: "Read Message History", flag: PermissionFlagsBits.ReadMessageHistory }
  ];
  const webhook = [...basic, { name: "Manage Webhooks", flag: PermissionFlagsBits.ManageWebhooks }];

  await checkChannelPermissions(CHANNELS.REMINDERS, "#guild-pings", basic);
  await checkChannelPermissions(CHANNELS.PREFERENCES, "#preferences", [...basic, { name: "Add Reactions", flag: PermissionFlagsBits.AddReactions }]);
  await checkChannelPermissions(CHANNELS.HELP, "#help", basic);
  await checkChannelPermissions(CHANNELS.EVENT_BOARD, "Live Event Board", basic);
  await checkChannelPermissions(CHANNELS.HIGHLIGHTS, "Community Highlights", basic);

  for (const info of Object.values(LANGUAGE_CHANNELS)) {
    await checkChannelPermissions(info.channel, `${info.name} General`, webhook);
  }

  const guild = getGuild();
  if (guild) {
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (me?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
      console.log("✅ Server: Manage Channels OK");
    } else {
      console.error("❌ Server: Missing Manage Channels");
    }
    const reactionTranslatePermissions = [
      ...basic,
      { name: "Manage Messages", flag: PermissionFlagsBits.ManageMessages }
    ];

    const reactionTranslateChannels = guild.channels.cache.filter(
      channel => isReactionTranslateChannel(channel)
    );

    console.log(`🌐 Translation audit: checking ${reactionTranslateChannels.size} supported text channel(s).`);

    for (const channel of reactionTranslateChannels.values()) {
      await checkChannelPermissions(
        channel.id,
        `🌐 Translate #${channel.name}`,
        reactionTranslatePermissions
      );
    }

    if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      console.error("❌ Server: Vestra is missing Manage Roles");
    } else {
      console.log("✅ Server: Manage Roles OK");
      const managedRoleIds = new Set([
        ASHEN_WARRIORS, ONBOARDING_COMPLETE,
        ...Object.values(LANGUAGES).map(x => x.role),
        ...Object.values(PLAYSTYLE).map(x => x.role),
        ...Object.values(SOCIAL).map(x => x.role),
        ...Object.values(REMINDERS).map(x => x.role),
        ...Object.values(TOURNAMENTS).map(x => x.role)
      ]);
      const tooHigh = guild.roles.cache
        .filter(role => managedRoleIds.has(role.id) && role.position >= me.roles.highest.position)
        .map(role => role.name);
      if (tooHigh.length) console.error(`❌ Role hierarchy: move Vestra above ${tooHigh.join(", ")}`);
      else console.log("✅ Role hierarchy: Vestra can manage all community roles");
    }
  }

  console.log("✅ Startup permission audit finished.");
}

// =====================================================
// MEMBER JOIN + REACTION ROLES
// =====================================================

client.on(Events.GuildMemberAdd, async member => {
  if (member.user.bot) return;
  try {
    await member.roles.add(ASHEN_WARRIORS);
    console.log(`✅ Ashen Warriors added to ${member.user.tag}`);
    await setupGuildMembersPanel().catch(() => {});
  } catch (error) {
    console.error("❌ Could not add Ashen Warriors:", error.message);
  }
});

client.on(Events.GuildMemberRemove, async member => {
  if (member.user.bot) return;
  await setupGuildMembersPanel().catch(() => {});
});

function itemByEmoji(group, emoji) {
  return Object.values(group).find(x => x.emoji === emoji);
}

async function reactionRole(reaction, user, adding) {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch();
  const message = reaction.message;
  if (!message.guild) return;
  const member = await message.guild.members.fetch(user.id);
  const emoji = reaction.emoji.name;

  if (message.id === preferenceMessages.languages?.id) {
    const item = itemByEmoji(LANGUAGES, emoji);
    if (!item) return;
    if (adding) {
      await member.roles.add(item.role);
      const existing = await pool.query("SELECT primary_language FROM user_preferences WHERE user_id = $1", [member.id]);
      if (!existing.rows[0]?.primary_language) {
        const key = Object.entries(LANGUAGES).find(([, value]) => value.role === item.role)?.[0];
        if (key) await savePrimaryLanguage(member.id, key);
      }
    } else {
      await member.roles.remove(item.role);
      const current = await inferPrimaryLanguage(member);
      if (LANGUAGE_CHANNELS[current].role === item.role) {
        const fallback = LANGUAGE_KEYS.find(key => key !== current && member.roles.cache.has(LANGUAGE_CHANNELS[key].role));
        if (fallback) await savePrimaryLanguage(member.id, fallback);
      }
    }
    return;
  }

  if (message.id === preferenceMessages.reminders?.id) {
    const item = itemByEmoji(REMINDERS, emoji);
    if (!item) return;
    if (adding) await member.roles.add(item.role); else await member.roles.remove(item.role);
    return;
  }

  if (message.id === preferenceMessages.tournaments?.id) {
    const item = itemByEmoji(TOURNAMENTS, emoji);
    if (!item) return;
    if (adding) await member.roles.add(item.role); else await member.roles.remove(item.role);
    return;
  }

  if (message.id === preferenceMessages.playstyle?.id) {
    const item = itemByEmoji(PLAYSTYLE, emoji);
    if (!item) return;
    if (adding) {
      for (const other of Object.values(PLAYSTYLE)) {
        if (other.role !== item.role && member.roles.cache.has(other.role)) await member.roles.remove(other.role);
      }
      await member.roles.add(item.role);
    } else await member.roles.remove(item.role);
    return;
  }

  if (message.id === preferenceMessages.social?.id) {
    const item = itemByEmoji(SOCIAL, emoji);
    if (!item) return;
    if (adding) {
      for (const other of Object.values(SOCIAL)) {
        if (other.role !== item.role && member.roles.cache.has(other.role)) await member.roles.remove(other.role);
      }
      await member.roles.add(item.role);
    } else await member.roles.remove(item.role);
  }
}

// =====================================================
// MESSAGE EVENTS
// =====================================================

client.on(Events.MessageCreate, async message => {
  try {
    if (!message.guild || message.author.bot || message.webhookId) return;

    if (languageByChannel(message.channel.id)) {
      await handleGeneralMessageCreate(message);
      return;
    }

  } catch (error) {
    console.error("❌ MessageCreate handler:", error);
  }
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    if (newMessage.partial) newMessage = await newMessage.fetch();
    if (!newMessage.guild || newMessage.author?.bot || newMessage.webhookId) return;
    if (languageByChannel(newMessage.channel.id)) await handleGeneralMessageUpdate(newMessage);
  } catch (error) {
    console.error("❌ MessageUpdate handler:", error);
  }
});

client.on(Events.MessageDelete, async message => {
  try {
    const mapping = await getGroupByMessageId(message.id).catch(() => null);
    if (mapping?.is_source) {
      await deleteTranslatedGroup(mapping.group_id);
      await removeHighlight(message.id);
      console.log(`🗑️ Deleted translated copies for ${message.id}`);
      return;
    }
    if (mapping && !mapping.is_source) {
      await pool.query("DELETE FROM translation_messages WHERE message_id = $1", [message.id]);
      await pool.query("DELETE FROM message_reactions WHERE message_id = $1", [message.id]);
      return;
    }

    await removeHighlight(message.id);
  } catch (error) {
    console.error("❌ MessageDelete handler:", error);
  }
});

// =====================================================
// REACTION SYNC + HIGHLIGHTS
// =====================================================

async function handleReactionChange(reaction, user, adding) {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch();

  try {
    reaction.message = await reaction.message.fetch();
  } catch {
    if (reaction.message.partial) await reaction.message.fetch();
  }

  // Old reaction-role panels still work.
  await reactionRole(reaction, user, adding).catch(() => {});

  // In supported text channels, 🌐 is a translation request rather than a highlight reaction.
  if (adding && isReactionTranslateChannel(reaction.message.channel) && emojiKey(reaction.emoji) === SOCIAL_TRANSLATE_EMOJI) {
    await handleSocialTranslationReaction(reaction, user);
    return;
  }

  const mapping = await getGroupByMessageId(reaction.message.id).catch(() => null);
  if (mapping) {
    const key = emojiKey(reaction.emoji);
    if (adding) {
      await pool.query(
        `INSERT INTO message_reactions(message_id, group_id, user_id, emoji_key)
         VALUES($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [reaction.message.id, mapping.group_id, user.id, key]
      );
    } else {
      await pool.query(
        "DELETE FROM message_reactions WHERE message_id = $1 AND group_id = $2 AND user_id = $3 AND emoji_key = $4",
        [reaction.message.id, mapping.group_id, user.id, key]
      );
    }

    await updateReactionSummaries(mapping.group_id);
    if (adding) await maybeHighlightGroup(mapping.group_id);
    return;
  }

  if (adding) await maybeHighlightNative(reaction.message);
}

client.on(Events.MessageReactionAdd, (reaction, user) => {
  void handleReactionChange(reaction, user, true).catch(error => console.error("❌ Reaction add:", error));
});

client.on(Events.MessageReactionRemove, (reaction, user) => {
  void handleReactionChange(reaction, user, false).catch(error => console.error("❌ Reaction remove:", error));
});

// =====================================================
// INTERACTIONS
// =====================================================

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isButton() && interaction.customId === "admin_apply_theme") {
      if (!isStaff(interaction.member)) {
        return interaction.reply({
          content: "🖤 This control is only available to Ashen staff.",
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
      const canManageChannels = !!me?.permissions?.has(PermissionFlagsBits.ManageChannels);

      if (!canManageChannels) {
        return interaction.editReply(
          "❌ Vestra does not currently have **Manage Channels** in this server."
        );
      }

      const report = await applyAshenSidebarTheme(interaction.guild);

      const renamed = report.renamed.length
        ? report.renamed.slice(0, 12).map(x => `✅ ${x}`).join("\n")
        : "No channel names needed changing.";

      const created = report.created.length
        ? "\n\n**Final separator / ending categories:**\n" +
          report.created.map(x => `✦ ${x}`).join("\n")
        : "";

      const failed = report.failed.length
        ? "\n\n**Couldn’t change:**\n" + report.failed.slice(0, 8).map(x => `❌ ${x}`).join("\n")
        : "";

      return interaction.editReply({
        content:
          `# 🖤 Ashen Theme Applied\n\n` +
          `**Server:** ${report.guildName || "Unknown"}\n` +
          `**Server ID:** ${report.guildId || "Unknown"}\n` +
          `**Renamed:** ${report.renamed.length}\n` +
          `**Old decorations removed:** ${report.removed?.length || 0}\n` +
          `**Final decorations created:** ${report.created.length}\n` +
          `**Already styled:** ${report.skipped.length}\n` +
          `**Failed:** ${report.failed.length}\n\n` +
          renamed +
          created +
          failed
      });
    }

    // -------------------------------------------------
    // HELP BUTTONS
    // -------------------------------------------------
    if (interaction.isButton() && interaction.customId === "help_game") {
      return interaction.showModal(createHelpModal("modal_game_help", "Game Help", "What do you need help with?", "Explain what you're stuck on..."));
    }
    if (interaction.isButton() && interaction.customId === "help_team") {
      return interaction.showModal(createHelpModal("modal_team_help", "Find a Team", "What are you looking for?", "Tell everyone what you need teammates for..."));
    }
    if (interaction.isButton() && interaction.customId === "help_staff") {
      return interaction.showModal(createHelpModal("modal_staff_help", "Contact Ashen Staff", "What would you like staff to know?", "Explain your request or concern..."));
    }
    if (interaction.isButton() && interaction.customId === "help_discord") {
      return interaction.showModal(createHelpModal("modal_discord_help", "Discord Help", "What do you need help with?", "Explain the Discord or server issue..."));
    }
    if (interaction.isButton() && interaction.customId === "help_faq") {
      return interaction.reply({
        content:
          "# ❓ Ashen FAQ\n\n" +
          `🌎 **Languages / notification language:** <#${CHANNELS.PREFERENCES}>\n` +
          `🔔 **Reminder pings:** <#${CHANNELS.PREFERENCES}>\n` +
          "🌐 **Quick translation:** in supported text channels, react 🌐 to a message and Vestra will temporarily translate it into your primary language.\n" +
          "🛡️ **Private staff help:** use Ask Staff in this Help Center.",
        flags: MessageFlags.Ephemeral
      });
    }
    if (interaction.isButton() && interaction.customId === "help_guide") {
      return interaction.reply({
        content:
          `# 🧭 Ashen Server Guide\n\n📍 <#${CHANNELS.START_HERE}> — Start here\n📜 <#${CHANNELS.RULES}> — Rules\n🌎 <#${CHANNELS.ONBOARDING}> — Onboarding\n✨ <#${CHANNELS.PREFERENCES}> — Vestra settings\n👋 <#${CHANNELS.INTRODUCTIONS}> — Introductions\n🆘 <#${CHANNELS.HELP}> — Help Center`,
        flags: MessageFlags.Ephemeral
      });
    }

    // -------------------------------------------------
    // HELP MODALS
    // -------------------------------------------------
    if (interaction.isModalSubmit() && interaction.customId === "modal_game_help") {
      return createHelpThread(interaction, "Game Help", "🎮", interaction.fields.getTextInputValue("help_details"));
    }
    if (interaction.isModalSubmit() && interaction.customId === "modal_team_help") {
      return createHelpThread(interaction, "Looking for a Team", "👥", interaction.fields.getTextInputValue("help_details"));
    }
    if (interaction.isModalSubmit() && interaction.customId === "modal_discord_help") {
      return createHelpThread(interaction, "Discord Help", "⚙️", interaction.fields.getTextInputValue("help_details"));
    }
    if (interaction.isModalSubmit() && interaction.customId === "modal_staff_help") {
      const details = interaction.fields.getTextInputValue("help_details");
      const staffChannel = await interaction.guild.channels.fetch(CHANNELS.STAFF_REQUESTS);

      if (!staffChannel?.isTextBased()) {
        return interaction.reply({
          content: "❌ Vestra couldn't reach the staff request channel.",
          flags: MessageFlags.Ephemeral
        });
      }

      const requestEmbed = brandEmbed(
        "🛡️ New Staff Request",
        details
      )
        .addFields(
          {
            name: "👤 Member",
            value: `${interaction.member}`,
            inline: true
          },
          {
            name: "🪪 Username",
            value: interaction.user.username,
            inline: true
          },
          {
            name: "📌 Status",
            value: "New • Needs Review",
            inline: true
          }
        )
        .setFooter({ text: "Vestra • Private Staff Request" })
        .setTimestamp();

      await staffChannel.send({
        content: `<@&${STAFF_ROLES.LEADER}> <@&${STAFF_ROLES.DEPUTY}> <@&${STAFF_ROLES.OFFICERS}>`,
        embeds: [requestEmbed],
        allowedMentions: {
          parse: [],
          roles: [
            STAFF_ROLES.LEADER,
            STAFF_ROLES.DEPUTY,
            STAFF_ROLES.OFFICERS
          ]
        }
      });

      return interaction.reply({
        content: "✅ Your message was sent privately to Ashen staff.",
        flags: MessageFlags.Ephemeral
      });
    }

    // -------------------------------------------------
    // ONBOARDING
    // -------------------------------------------------

    if (
      interaction.isButton() &&
      interaction.customId === "start_onboarding"
    ) {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      const session = {
        language: null,
        reminders: [],
        playstyle: null,
        social: null
      };

      await saveOnboardingSession(
        interaction.user.id,
        session
      );

      return interaction.editReply({
        content: onboardingStepContent(
          "STEP 1 OF 4",
          "🌎 Set Your Language",
          `Pick the language Vestra should use for your **notifications** and 🌐 reaction translations.

You can unlock additional language chats later in Role Preferences.`
        ),
        embeds: [],
        components: [
          languageMenu()
        ]
      });
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "onboard_language"
    ) {
      await interaction.deferUpdate();

      const language =
        interaction.values[0];

      const session =
        await getOnboardingSession(
          interaction.user.id
        ) || {
          language: null,
          reminders: [],
          playstyle: null,
          social: null
        };

      session.language =
        language;

      session.reminders =
        [];

      session.playstyle =
        null;

      session.social =
        null;

      await saveOnboardingSession(
        interaction.user.id,
        session
      );

      return interaction.editReply({
        content: onboardingStepContent(
          "STEP 2 OF 4",
          "🔔 Choose Your Alerts",
          `${TEXT[language].reminders}

Choose **as many as you want**. This includes regular guild reminders plus Server Tournament and Nexus Tournament alerts. You can change these anytime.`
        ),
        embeds: [],
        components: [
          reminderMenu(
            language
          )
        ]
      });
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "onboard_reminders"
    ) {
      await interaction.deferUpdate();

      const session =
        await getOnboardingSession(
          interaction.user.id
        );

      if (!session) {
        return interaction.editReply({
          embeds: [
            brandEmbed(
              "⚠️ Onboarding Session Missing",
              "Your onboarding session could not be found. Press **Start Onboarding** again and Vestra will restart it for you."
            )
          ],
          components: []
        });
      }

      session.reminders =
        interaction.values.includes(
          "none"
        )
          ? []
          : interaction.values.filter(
              value =>
                value !== "none"
            );

      await saveOnboardingSession(
        interaction.user.id,
        session
      );

      return interaction.editReply({
        content: onboardingStepContent(
          "STEP 3 OF 4",
          "🎮 Pick Your Playstyle",
          `${TEXT[session.language].playstyle}

This is just for fun and helps other members get a feel for how you like to play.`
        ),
        embeds: [],
        components: [
          playstyleMenu(
            session.language
          )
        ]
      });
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "onboard_playstyle"
    ) {
      await interaction.deferUpdate();

      const session =
        await getOnboardingSession(
          interaction.user.id
        );

      if (!session) {
        return interaction.editReply({
          embeds: [
            brandEmbed(
              "⚠️ Onboarding Session Missing",
              "Press **Start Onboarding** again to restart your setup."
            )
          ],
          components: []
        });
      }

      session.playstyle =
        interaction.values[0] ===
        "skip"
          ? null
          : interaction.values[0];

      await saveOnboardingSession(
        interaction.user.id,
        session
      );

      return interaction.editReply({
        content: onboardingStepContent(
          "STEP 4 OF 4",
          "💬 Set Your Social Vibe",
          `${TEXT[session.language].social}

There’s no wrong answer — this just gives the community a small hint about how you like to interact.`
        ),
        embeds: [],
        components: [
          socialMenu(
            session.language
          )
        ]
      });
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "onboard_social"
    ) {
      await interaction.deferUpdate();

      const session =
        await getOnboardingSession(
          interaction.user.id
        );

      if (!session) {
        return interaction.editReply({
          embeds: [
            brandEmbed(
              "⚠️ Onboarding Session Missing",
              "Press **Start Onboarding** again to restart your setup."
            )
          ],
          components: []
        });
      }

      session.social =
        interaction.values[0] ===
        "skip"
          ? null
          : interaction.values[0];

      await saveOnboardingSession(
        interaction.user.id,
        session
      );

      const language = LANGUAGES[session.language];
      const playstyle = session.playstyle ? PLAYSTYLE[session.playstyle] : null;
      const social = session.social ? SOCIAL[session.social] : null;
      const reminderNames = (session.reminders || []).map(key => {
        if (REMINDERS[key]) return `${REMINDERS[key].emoji} ${REMINDERS[key].name}`;
        if (key.startsWith("tournament:")) {
          const tournament = TOURNAMENTS[key.split(":")[1]];
          return tournament ? `${tournament.emoji} ${tournament.name}` : key;
        }
        return key;
      });

      return interaction.editReply({
        content: `# ✅ Ready to Join Ashen Warriors

Everything looks good! Review your choices below, then press **Finish Onboarding**.

## 🌎 Primary Language
${language.emoji} **${language.name}**

## 🔔 Pings
${reminderNames.length ? reminderNames.join("\n") : "🔕 No reminders"}

## 🎮 Playstyle
${playstyle ? `${playstyle.emoji} **${playstyle.name}**` : "Not specified"}

## 💬 Social Vibe
${social ? `${social.emoji} **${social.name}**` : "Not specified"}

*You can change all of this later in Role Preferences.*`,
        embeds: [],
        components: [
          finishButton(
            session.language
          )
        ]
      });
    }

    if (
      interaction.isButton() &&
      interaction.customId === "onboard_finish"
    ) {
      await interaction.deferUpdate();

      const session =
        await getOnboardingSession(
          interaction.user.id
        );

      if (!session?.language) {
        return interaction.editReply({
          embeds: [
            brandEmbed(
              "⚠️ Onboarding Needs to Restart",
              "Vestra couldn’t recover your language selection. Press **Start Onboarding** again — your progress is now saved in the database during future restarts."
            )
          ],
          components: []
        });
      }

      const member =
        await interaction.guild.members.fetch(
          interaction.user.id
        );

      const rolesToRemove =
        [...RESETTABLE_ROLES]
          .filter(
            roleId =>
              !PROTECTED_ROLES.has(
                roleId
              ) &&
              member.roles.cache.has(
                roleId
              )
          );

      if (
        rolesToRemove.length
      ) {
        await member.roles.remove(
          rolesToRemove
        );
      }

      const rolesToAdd =
        new Set([
          ASHEN_WARRIORS,
          LANGUAGES[
            session.language
          ].role,
          ONBOARDING_COMPLETE
        ]);

      for (
        const key of
        session.reminders || []
      ) {
        if (REMINDERS[key]) {
          rolesToAdd.add(
            REMINDERS[key].role
          );

          continue;
        }

        if (
          key.startsWith(
            "tournament:"
          )
        ) {
          const tournamentKey =
            key.split(":")[1];

          if (
            TOURNAMENTS[
              tournamentKey
            ]
          ) {
            rolesToAdd.add(
              TOURNAMENTS[
                tournamentKey
              ].role
            );
          }
        }
      }

      if (session.playstyle) {
        rolesToAdd.add(
          PLAYSTYLE[
            session.playstyle
          ].role
        );
      }

      if (session.social) {
        rolesToAdd.add(
          SOCIAL[
            session.social
          ].role
        );
      }

      await member.roles.add(
        [...rolesToAdd]
      );

      await savePrimaryLanguage(
        member.id,
        session.language
      );

      const intro =
        await interaction.guild.channels.fetch(
          CHANNELS.INTRODUCTIONS
        ).catch(() => null);

      if (
        intro?.isTextBased()
      ) {
        await intro.send({
          content:
            `${member}`,

          embeds: [
            welcomeCard(
              member,

              LANGUAGES[
                session.language
              ].name,

              session.playstyle
                ? PLAYSTYLE[
                    session.playstyle
                  ].name
                : "Not specified",

              session.social
                ? SOCIAL[
                    session.social
                  ].name
                : "Not specified"
            )
          ],

          allowedMentions: {
            parse: [],
            users: [
              member.id
            ]
          }
        });
      }

      await deleteOnboardingSession(
        interaction.user.id
      );

      await setupGuildMembersPanel()
        .catch(() => {});

      return interaction.editReply({
        content: `# ✅ Welcome to Ashen Warriors!

${TEXT[session.language].done}

Your roles and Vestra preferences are saved. The rest of Ashen is ready for you now.

Head into the server, say hi, and make yourself at home. 🖤`,
        embeds: [],
        components: []
      });
    }

    // -------------------------------------------------
    // SETTINGS HOME
    // -------------------------------------------------
    if (interaction.isButton() && interaction.customId === "settings_open") {
      const payload = { embeds: [settingsHomeEmbed()], components: settingsHomeComponents() };
      if (interaction.message?.flags?.has?.(MessageFlags.Ephemeral)) return interaction.update(payload);
      return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }

    if (interaction.isButton() && interaction.customId === "settings_back") {
      return interaction.update({ embeds: [settingsHomeEmbed()], components: settingsHomeComponents() });
    }

    if (interaction.isButton() && interaction.customId === "settings_card") {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const embed = await memberCardEmbed(member);
      if (interaction.message?.flags?.has?.(MessageFlags.Ephemeral)) {
        return interaction.update({ embeds: [embed], components: [backButtonRow()] });
      }
      return interaction.reply({ embeds: [embed], components: [backButtonRow()], flags: MessageFlags.Ephemeral });
    }

    if (interaction.isButton() && interaction.customId === "settings_languages") {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const selected = LANGUAGE_KEYS.filter(key => member.roles.cache.has(LANGUAGE_CHANNELS[key].role));
      const menu = new StringSelectMenuBuilder()
        .setCustomId("settings_languages_select")
        .setPlaceholder("Choose every language channel you want")
        .setMinValues(1)
        .setMaxValues(LANGUAGE_KEYS.length)
        .addOptions(LANGUAGE_KEYS.map(key => ({
          label: LANGUAGE_CHANNELS[key].name,
          value: key,
          emoji: LANGUAGE_CHANNELS[key].emoji,
          default: selected.includes(key)
        })));
      return interaction.update({
        embeds: [new EmbedBuilder().setTitle("🌎 Language Access").setDescription("Choose every General language channel you want to see.")],
        components: [new ActionRowBuilder().addComponents(menu), backButtonRow()]
      });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "settings_languages_select") {
      await interaction.deferUpdate();
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const selected = new Set(interaction.values);
      for (const key of LANGUAGE_KEYS) {
        const role = LANGUAGE_CHANNELS[key].role;
        if (selected.has(key) && !member.roles.cache.has(role)) await member.roles.add(role).catch(() => {});
        if (!selected.has(key) && member.roles.cache.has(role)) await member.roles.remove(role).catch(() => {});
      }
      const primary = await inferPrimaryLanguage(member);
      if (!selected.has(primary)) await savePrimaryLanguage(member.id, interaction.values[0]);
      return interaction.editReply({
        embeds: [brandEmbed("✅ Language Access Updated", "Your language channel access has been saved.")],
        components: [backButtonRow()]
      });
    }

    if (interaction.isButton() && interaction.customId === "settings_notify") {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const current = await inferPrimaryLanguage(member);
      const menu = new StringSelectMenuBuilder()
        .setCustomId("settings_notify_select")
        .setPlaceholder("Choose one notification language")
        .addOptions(LANGUAGE_KEYS.map(key => ({
          label: LANGUAGE_CHANNELS[key].name,
          value: key,
          emoji: LANGUAGE_CHANNELS[key].emoji,
          default: current === key
        })));
      return interaction.update({
        embeds: [new EmbedBuilder().setTitle("🔔 Primary Notification Language").setDescription("Vestra sends your event pings **once**, in this language's General channel.")],
        components: [new ActionRowBuilder().addComponents(menu), backButtonRow()]
      });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "settings_notify_select") {
      await interaction.deferUpdate();
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const key = interaction.values[0];
      if (!member.roles.cache.has(LANGUAGE_CHANNELS[key].role)) await member.roles.add(LANGUAGE_CHANNELS[key].role);
      await savePrimaryLanguage(member.id, key);
      return interaction.editReply({
        embeds: [brandEmbed(
          "✅ Notification Language Updated",
          `${LANGUAGE_CHANNELS[key].emoji} Vestra will notify you in **${LANGUAGE_CHANNELS[key].name}**.`
        )],
        components: [backButtonRow()]
      });
    }

    if (interaction.isButton() && interaction.customId === "settings_reminders") {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const selected = Object.entries(REMINDERS).filter(([, item]) => member.roles.cache.has(item.role)).map(([key]) => key);
      const menu = new StringSelectMenuBuilder()
        .setCustomId("settings_reminders_select")
        .setPlaceholder("Choose game alerts")
        .setMinValues(1)
        .setMaxValues(8)
        .addOptions(
          ...Object.entries(REMINDERS).map(([key, item]) => ({ label: item.name, value: key, emoji: item.emoji, default: selected.includes(key) })),
          { label: "No game pings", value: "none", emoji: "🔕", default: selected.length === 0 }
        );
      return interaction.update({
        embeds: [new EmbedBuilder().setTitle("⏰ Game Reminder Pings").setDescription("Choose the events you want Vestra to notify you about.")],
        components: [new ActionRowBuilder().addComponents(menu), backButtonRow()]
      });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "settings_reminders_select") {
      await interaction.deferUpdate();
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const selected = interaction.values.includes("none") ? new Set() : new Set(interaction.values);
      for (const [key, item] of Object.entries(REMINDERS)) {
        if (selected.has(key) && !member.roles.cache.has(item.role)) await member.roles.add(item.role).catch(() => {});
        if (!selected.has(key) && member.roles.cache.has(item.role)) await member.roles.remove(item.role).catch(() => {});
      }
      return interaction.editReply({
        embeds: [brandEmbed("✅ Game Pings Updated", "Your game and guild reminder choices have been saved.")],
        components: [backButtonRow()]
      });
    }

    if (interaction.isButton() && interaction.customId === "settings_tournaments") {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const selected = Object.entries(TOURNAMENTS).filter(([, item]) => member.roles.cache.has(item.role)).map(([key]) => key);
      const menu = new StringSelectMenuBuilder()
        .setCustomId("settings_tournaments_select")
        .setPlaceholder("Choose tournament alerts")
        .setMinValues(1)
        .setMaxValues(3)
        .addOptions(
          { label: "Server Tournament", value: "sever", emoji: "⚔️", default: selected.includes("sever") },
          { label: "Nexus Tournament", value: "nexus", emoji: "🌀", default: selected.includes("nexus") },
          { label: "No tournament pings", value: "none", emoji: "🔕", default: selected.length === 0 }
        );
      return interaction.update({
        embeds: [new EmbedBuilder().setTitle("🏆 Tournament Pings").setDescription("Opt in to Server Tournament, Nexus Tournament, both, or neither.")],
        components: [new ActionRowBuilder().addComponents(menu), backButtonRow()]
      });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "settings_tournaments_select") {
      await interaction.deferUpdate();
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const selected = interaction.values.includes("none") ? new Set() : new Set(interaction.values);
      for (const [key, item] of Object.entries(TOURNAMENTS)) {
        if (selected.has(key) && !member.roles.cache.has(item.role)) await member.roles.add(item.role).catch(() => {});
        if (!selected.has(key) && member.roles.cache.has(item.role)) await member.roles.remove(item.role).catch(() => {});
      }
      return interaction.editReply({
        embeds: [brandEmbed("✅ Tournament Pings Updated", "Your Server Tournament and Nexus Tournament alert choices have been saved.")],
        components: [backButtonRow()]
      });
    }

    if (interaction.isButton() && interaction.customId === "settings_playstyle") {
      const menu = new StringSelectMenuBuilder()
        .setCustomId("settings_playstyle_select")
        .setPlaceholder("Choose your playstyle")
        .addOptions(
          ...Object.entries(PLAYSTYLE).map(([key, item]) => ({ label: item.name, value: key, emoji: item.emoji })),
          { label: "None", value: "none", emoji: "⏭️" }
        );
      return interaction.update({ embeds: [new EmbedBuilder().setTitle("🎮 Playstyle")], components: [new ActionRowBuilder().addComponents(menu), backButtonRow()] });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "settings_playstyle_select") {
      await interaction.deferUpdate();
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const selected = interaction.values[0] === "none" ? null : interaction.values[0];
      await updateSingleChoiceRole(member, PLAYSTYLE, selected);
      return interaction.editReply({
        embeds: [brandEmbed("✅ Playstyle Updated", "Your playstyle has been saved.")],
        components: [backButtonRow()]
      });
    }

    if (interaction.isButton() && interaction.customId === "settings_social") {
      const menu = new StringSelectMenuBuilder()
        .setCustomId("settings_social_select")
        .setPlaceholder("Choose your social preference")
        .addOptions(
          ...Object.entries(SOCIAL).map(([key, item]) => ({ label: item.name, value: key, emoji: item.emoji })),
          { label: "None", value: "none", emoji: "⏭️" }
        );
      return interaction.update({ embeds: [new EmbedBuilder().setTitle("💬 Social Preference")], components: [new ActionRowBuilder().addComponents(menu), backButtonRow()] });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "settings_social_select") {
      await interaction.deferUpdate();
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const selected = interaction.values[0] === "none" ? null : interaction.values[0];
      await updateSingleChoiceRole(member, SOCIAL, selected);
      return interaction.editReply({
        embeds: [brandEmbed("✅ Social Preference Updated", "Your social preference has been saved.")],
        components: [backButtonRow()]
      });
    }

    // -------------------------------------------------
    // TOURNAMENT STAFF CONTROLS
    // -------------------------------------------------
    if (interaction.isButton() && interaction.customId === "tournament_next") {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!isStaff(member)) return interaction.reply({ content: "❌ Only Ashen staff can advance tournament rounds.", flags: MessageFlags.Ephemeral });
      const state = await getActiveTournamentState();
      if (!state || state.phase !== "battle") return interaction.reply({ content: "❌ There isn't a battle waiting for the next vote right now.", flags: MessageFlags.Ephemeral });
      const tournament = TOURNAMENTS[state.tournament];
      if (state.round >= tournament.rounds) return interaction.reply({ content: "Round 4 is already complete. Use Finish Tournament after the final battle.", flags: MessageFlags.Ephemeral });
      await startTournamentVote(state.tournament, state.round + 1, true);
      return interaction.reply({ content: `✅ Round ${state.round + 1} voting opened.`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.isButton() && interaction.customId === "tournament_finish") {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!isStaff(member)) return interaction.reply({ content: "❌ Only Ashen staff can finish Tournament Mode.", flags: MessageFlags.Ephemeral });
      const state = await getActiveTournamentState();
      if (!state) return interaction.reply({ content: "❌ No active tournament.", flags: MessageFlags.Ephemeral });
      await finishTournament(state.tournament);
      return interaction.reply({ content: "🏁 Tournament Mode finished. The Live Event Board is back to normal.", flags: MessageFlags.Ephemeral });
    }

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

// =====================================================
// VESTRA IDENTITY
// =====================================================

async function enforceVestraIdentity(readyClient) {
  if (readyClient.user.username !== BOT_NAME) {
    try {
      await readyClient.user.setUsername(BOT_NAME);
      console.log(`✅ Bot username changed to ${BOT_NAME}.`);
    } catch (error) {
      console.error(
        `⚠️ Could not change global bot username to ${BOT_NAME}:`,
        error.message
      );
    }
  }

  const guild = await resolveAshenGuild().catch(() => null);
  if (!guild) return;

  const me =
    guild.members.me ||
    await guild.members.fetchMe().catch(() => null);

  if (me && me.displayName !== BOT_NAME) {
    try {
      await me.setNickname(
        BOT_NAME,
        "Use Vestra branding in Ashen Warriors"
      );
      console.log(`✅ Ashen bot nickname changed to ${BOT_NAME}.`);
    } catch (error) {
      console.error(
        `⚠️ Could not change Ashen nickname to ${BOT_NAME}:`,
        error.message
      );
    }
  }
}

// =====================================================
// READY
// =====================================================

client.once(Events.ClientReady, async readyClient => {
  console.log(`✅ ${BOT_NAME} online as ${readyClient.user.tag}`);

  await enforceVestraIdentity(readyClient);

  try {
    await initDatabase();
    await cleanupLegacySocialCompanions();
  } catch (error) {
    console.error("❌ DATABASE FAILED TO INITIALIZE:", error);
    return;
  }

  await cleanupLegacyWelcomePanels().catch(error => {
    console.error("⚠️ Legacy panel cleanup:", error.message);
  });

  const ashenGuild = await resolveAshenGuild().catch(() => null);

  await recoverAshenMainCategories(ashenGuild).catch(error => {
    console.error("⚠️ Emergency Ashen category recovery:", error.message);
  });

  await applyAshenSidebarTheme(ashenGuild).catch(error => {
    console.error("⚠️ Ashen sidebar theme:", error.message);
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
    ["Guild Ping Log", setupGuildPingsPanel],
    ["Live Event Board", setupEventBoard]
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

  startScheduler();

  console.log("✅ Google Cloud Translation active.");
  console.log("✅ Persistent edit/delete/reaction sync active.");
  console.log("✅ Synced reply links active across translated channels.");
  console.log("✅ 🌐 reaction translations active across Social, Important, Welcome, SxS Media, and SxS Resources.");
  console.log("✅ Primary-language notification delivery active.");
  console.log("✅ Server + Nexus Tournament Mode active with manual voting rounds.");
  console.log("✅ Community Highlights active.");
});

// =====================================================
// LOGIN
// =====================================================

client.login(process.env.DISCORD_BOT);