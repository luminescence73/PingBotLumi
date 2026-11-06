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
  PermissionFlagsBits
} from "discord.js";
import pg from "pg";
import { createHash } from "node:crypto";

const { Pool } = pg;

// =====================================================
// VESTRA — ASHEN WARRIORS
// =====================================================

const BOT_NAME = "Vestra";
const TZ = "America/Chicago";
const GOOGLE_TRANSLATE_URL =
  "https://translation.googleapis.com/language/translate/v2";
const HIGHLIGHT_REACTION_THRESHOLD = 4;

// =====================================================
// REQUIRED ENVIRONMENT VARIABLES
// =====================================================

for (const required of [
  "DISCORD_BOT",
  "GOOGLE_TRANSLATE_API_KEY",
  "DATABASE_URL"
]) {
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
     ON CONFLICT(key) DO UPDATE
     SET value = EXCLUDED.value,
         updated_at = NOW()`,
    [
      key,
      JSON.stringify(value)
    ]
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

const SOCIAL_CATEGORY_ID =
  "1542252166222315532";

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

const LANGUAGE_KEYS =
  Object.keys(
    LANGUAGE_CHANNELS
  );

function languageByChannel(
  channelId
) {
  return (
    Object.entries(
      LANGUAGE_CHANNELS
    ).find(
      ([, info]) =>
        info.channel ===
        channelId
    ) || null
  );
}

// =====================================================
// ROLES
// =====================================================

const ASHEN_WARRIORS =
  "1507567323161038899";

const ONBOARDING_COMPLETE =
  "1540336639635628032";

const STAFF_ROLES = {
  OWNER:
    "1507567387774423171",

  ADMIN:
    "1507567296447516714",

  LEADER:
    "1508987283934543992",

  DEPUTY:
    "1507567404836847747",

  OFFICERS:
    "1507567452391870544"
};

const PROTECTED_ROLES =
  new Set(
    Object.values(
      STAFF_ROLES
    )
  );

const LANGUAGES =
  Object.fromEntries(
    Object.entries(
      LANGUAGE_CHANNELS
    ).map(
      ([key, value]) => [
        key,
        {
          name: value.name,
          emoji: value.emoji,
          role: value.role
        }
      ]
    )
  );

const PLAYSTYLE = {
  casual: {
    name: "Casual",
    emoji: "🌿",
    role: "1540337903497117736"
  },

  competitive: {
    name: "Competitive",
    emoji: "⚔️",
    role: "1540337984459513877"
  },

  both: {
    name: "Both",
    emoji: "🎮",
    role: "1540338047189655552"
  }
};

const SOCIAL = {
  chatty: {
    name: "Chatty",
    emoji: "💬",
    role: "1540338102244216902"
  },

  quiet: {
    name: "Quiet",
    emoji: "🌙",
    role: "1540338180291694604"
  },

  either: {
    name: "Either",
    emoji: "✨",
    role: "1540338259761176606"
  }
};

const REMINDERS = {
  reset: {
    name: "Reset",
    emoji: "🔄",
    role: "1537936033273086073"
  },

  morning: {
    name: "Morning Conquest",
    emoji: "🌅",
    role: "1537936135114854430"
  },

  night: {
    name: "Night Conquest",
    emoji: "🌌",
    role: "1537936185979183194"
  },

  opening: {
    name: "Clash Opening Call",
    emoji: "🔔",
    role: "1537936269043310752"
  },

  battle: {
    name: "Clash Battle Call",
    emoji: "⚔️",
    role: "1537936402497675265"
  },

  final: {
    name: "Clash Final Call",
    emoji: "🚨",
    role: "1537936646442451075"
  },

  registration: {
    name: "Guild Clash Registration",
    emoji: "⏰",
    role: "1537936738998296618"
  }
};

const TOURNAMENTS = {
  sever: {
    name: "Sever Tournament",
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

const RESETTABLE_ROLES =
  new Set([
    ASHEN_WARRIORS,
    ONBOARDING_COMPLETE,

    ...Object.values(
      LANGUAGES
    ).map(
      x => x.role
    ),

    ...Object.values(
      PLAYSTYLE
    ).map(
      x => x.role
    ),

    ...Object.values(
      SOCIAL
    ).map(
      x => x.role
    ),

    ...Object.values(
      REMINDERS
    ).map(
      x => x.role
    )
  ]);

function isStaff(member) {
  return Object.values(
    STAFF_ROLES
  ).some(
    roleId =>
      member?.roles?.cache?.has(
        roleId
      )
  );
}

// =====================================================
// ONBOARDING TEXT
// =====================================================

const TEXT = {
  english: {
    welcome:
      "Welcome to Ashen Warriors!",

    reminders:
      "Which reminder pings would you like?",

    playstyle:
      "What is your playstyle?",

    social:
      "What is your social preference?",

    finish:
      "Finish Onboarding",

    done:
      "Your onboarding is complete! Welcome to Ashen Warriors!"
  },

  spanish: {
    welcome:
      "¡Bienvenido/a a Ashen Warriors!",

    reminders:
      "¿Qué recordatorios quieres recibir?",

    playstyle:
      "¿Cuál es tu estilo de juego?",

    social:
      "¿Cuál es tu preferencia social?",

    finish:
      "Finalizar incorporación",

    done:
      "¡Tu incorporación está completa! ¡Bienvenido/a a Ashen Warriors!"
  },

  french: {
    welcome:
      "Bienvenue chez Ashen Warriors !",

    reminders:
      "Quels rappels souhaitez-vous recevoir ?",

    playstyle:
      "Quel est votre style de jeu ?",

    social:
      "Quelle est votre préférence sociale ?",

    finish:
      "Terminer l’intégration",

    done:
      "Votre intégration est terminée ! Bienvenue chez Ashen Warriors !"
  },

  german: {
    welcome:
      "Willkommen bei Ashen Warriors!",

    reminders:
      "Welche Erinnerungen möchtest du erhalten?",

    playstyle:
      "Wie ist dein Spielstil?",

    social:
      "Was ist deine soziale Präferenz?",

    finish:
      "Onboarding abschließen",

    done:
      "Dein Onboarding ist abgeschlossen! Willkommen bei Ashen Warriors!"
  },

  portuguese: {
    welcome:
      "Bem-vindo(a) ao Ashen Warriors!",

    reminders:
      "Quais lembretes você deseja receber?",

    playstyle:
      "Qual é o seu estilo de jogo?",

    social:
      "Qual é a sua preferência social?",

    finish:
      "Concluir integração",

    done:
      "Sua integração está concluída! Bem-vindo(a) ao Ashen Warriors!"
  },

  japanese: {
    welcome:
      "Ashen Warriorsへようこそ！",

    reminders:
      "どのリマインダーを受け取りたいですか？",

    playstyle:
      "プレイスタイルを選んでください。",

    social:
      "交流スタイルを選んでください。",

    finish:
      "オンボーディングを完了",

    done:
      "オンボーディングが完了しました！Ashen Warriorsへようこそ！"
  }
};

const sessions =
  new Map();

// =====================================================
// GENERAL HELPERS
// =====================================================

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

function limitText(
  text,
  max = 1900
) {
  if (!text) {
    return "";
  }

  if (
    text.length <= max
  ) {
    return text;
  }

  return (
    `${text.slice(
      0,
      max - 3
    )}...`
  );
}

function chunks(
  array,
  size
) {
  const out = [];

  for (
    let i = 0;
    i < array.length;
    i += size
  ) {
    out.push(
      array.slice(
        i,
        i + size
      )
    );
  }

  return out;
}

function getGuild() {
  return (
    client.guilds.cache.first() ||
    null
  );
}

function safeDisplayName(
  member,
  user
) {
  return (
    member?.displayName ||
    user?.globalName ||
    user?.username ||
    "Member"
  );
}

function getMentionIds(
  text
) {
  const users =
    new Set();

  const roles =
    new Set();

  const regex =
    /<@!?(\d+)>|<@&(\d+)>/g;

  let match;

  while (
    (
      match =
        regex.exec(
          text
        )
    ) !== null
  ) {
    if (match[1]) {
      users.add(
        match[1]
      );
    }

    if (match[2]) {
      roles.add(
        match[2]
      );
    }
  }

  return {
    users:
      [...users],

    roles:
      [...roles]
  };
}

function formatAttachments(
  attachments
) {
  return [
    ...attachments.values()
  ]
    .map(
      a =>
        `📎 ${a.url}`
    )
    .join("\n");
}

function emojiKey(
  emoji
) {
  if (emoji.id) {
    return emoji.animated
      ? `<a:${emoji.name}:${emoji.id}>`
      : `<:${emoji.name}:${emoji.id}>`;
  }

  return emoji.name;
}

// =====================================================
// GOOGLE TRANSLATION — DISCORD CONTENT PROTECTION
// =====================================================

const translationCache =
  new Map();

const CACHE_TTL =
  60 *
  60 *
  1000;

function protectDiscordContent(
  input
) {
  let text =
    input || "";

  const replacements =
    [];

  const protect =
    regex => {
      text =
        text.replace(
          regex,
          match => {
            const token =
              `ZXQVESTRA${replacements.length}QXZ`;

            replacements.push({
              token,
              original:
                match
            });

            return token;
          }
        );
    };

  protect(
    /```[\s\S]*?```/g
  );

  protect(
    /`[^`\n]+`/g
  );

  protect(
    /<a?:[A-Za-z0-9_]+:\d+>/g
  );

  protect(
    /<@!?\d+>|<@&\d+>|<#\d+>|<t:\d+(?::[tTdDfFR])?>/g
  );

  protect(
    /https?:\/\/[^\s<>]+/g
  );

  return {
    text,
    replacements
  };
}

function restoreDiscordContent(
  input,
  replacements
) {
  let text =
    input || "";

  for (
    const item of
    replacements
  ) {
    text =
      text
        .split(
          item.token
        )
        .join(
          item.original
        );
  }

  return text;
}

function stripProtectedForCheck(
  input
) {
  let text =
    input || "";

  text =
    text.replace(
      /```[\s\S]*?```/g,
      " "
    );

  text =
    text.replace(
      /`[^`\n]+`/g,
      " "
    );

  text =
    text.replace(
      /<a?:[A-Za-z0-9_]+:\d+>/g,
      " "
    );

  text =
    text.replace(
      /<@!?\d+>|<@&\d+>|<#\d+>|<t:\d+(?::[tTdDfFR])?>/g,
      " "
    );

  text =
    text.replace(
      /https?:\/\/[^\s<>]+/g,
      " "
    );

  return text;
}

function hasTranslatableText(
  input
) {
  return /[\p{L}\p{N}]/u.test(
    stripProtectedForCheck(
      input
    )
  );
}

function decodeGoogleText(
  text
) {
  return (
    text || ""
  )
    .replace(
      /&quot;/g,
      '"'
    )
    .replace(
      /&#39;/g,
      "'"
    )
    .replace(
      /&lt;/g,
      "<"
    )
    .replace(
      /&gt;/g,
      ">"
    )
    .replace(
      /&amp;/g,
      "&"
    );
}

function translationCacheKey(
  text,
  source,
  target
) {
  return createHash(
    "sha256"
  )
    .update(
      `${source || "auto"}|${target}|${text}`
    )
    .digest(
      "hex"
    );
}

async function googleTranslate(
  text,
  targetCode,
  sourceCode = null
) {
  if (
    !text ||
    !hasTranslatableText(
      text
    )
  ) {
    return text;
  }

  if (
    sourceCode &&
    sourceCode === targetCode
  ) {
    return text;
  }

  const key =
    translationCacheKey(
      text,
      sourceCode,
      targetCode
    );

  const cached =
    translationCache.get(
      key
    );

  if (
    cached &&
    Date.now() -
      cached.time <
      CACHE_TTL
  ) {
    return cached.text;
  }

  const protectedMessage =
    protectDiscordContent(
      text
    );

  const body = {
    q:
      protectedMessage.text,

    target:
      targetCode,

    format:
      "text"
  };

  if (sourceCode) {
    body.source =
      sourceCode;
  }

  const response =
    await fetch(
      GOOGLE_TRANSLATE_URL,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",

          "X-goog-api-key":
            process.env
              .GOOGLE_TRANSLATE_API_KEY
        },

        body:
          JSON.stringify(
            body
          ),

        signal:
          AbortSignal.timeout(
            15000
          )
      }
    );

  if (!response.ok) {
    const errorText =
      await response
        .text()
        .catch(
          () => ""
        );

    throw new Error(
      `Google Translation HTTP ${response.status}: ${errorText.slice(
        0,
        300
      )}`
    );
  }

  const data =
    await response.json();

  const translated =
    data
      ?.data
      ?.translations
      ?.[0]
      ?.translatedText;

  if (
    typeof translated !==
    "string"
  ) {
    throw new Error(
      "Google returned no translated text."
    );
  }

  const restored =
    restoreDiscordContent(
      decodeGoogleText(
        translated
      ),
      protectedMessage.replacements
    );

  translationCache.set(
    key,
    {
      text:
        restored,

      time:
        Date.now()
    }
  );

  if (
    translationCache.size >
    2000
  ) {
    const first =
      translationCache
        .keys()
        .next()
        .value;

    if (first) {
      translationCache.delete(
        first
      );
    }
  }

  return restored;
}

// =====================================================
// PRIMARY LANGUAGE / USER PREFERENCES
// =====================================================

async function savePrimaryLanguage(
  userId,
  languageKey
) {
  if (
    !LANGUAGE_CHANNELS[
      languageKey
    ]
  ) {
    return;
  }

  await pool.query(
    `INSERT INTO user_preferences(
       user_id,
       primary_language,
       created_at,
       updated_at
     )
     VALUES($1, $2, NOW(), NOW())
     ON CONFLICT(user_id)
     DO UPDATE SET
       primary_language = EXCLUDED.primary_language,
       updated_at = NOW()`,

    [
      userId,
      languageKey
    ]
  );
}

async function inferPrimaryLanguage(
  member
) {
  const saved =
    await pool.query(
      "SELECT primary_language FROM user_preferences WHERE user_id = $1",
      [
        member.id
      ]
    );

  const savedLanguage =
    saved.rows[0]
      ?.primary_language;

  if (
    savedLanguage &&
    LANGUAGE_CHANNELS[
      savedLanguage
    ]
  ) {
    return savedLanguage;
  }

  const owned =
    LANGUAGE_KEYS.filter(
      key =>
        member.roles.cache.has(
          LANGUAGE_CHANNELS[
            key
          ].role
        )
    );

  let chosen =
    owned.length === 1
      ? owned[0]
      : owned.includes(
          "english"
        )
        ? "english"
        : owned[0] ||
          "english";

  await savePrimaryLanguage(
    member.id,
    chosen
  );

  return chosen;
}

async function loadPrimaryLanguageMap(
  userIds
) {
  if (
    !userIds.length
  ) {
    return new Map();
  }

  const result =
    await pool.query(
      "SELECT user_id, primary_language FROM user_preferences WHERE user_id = ANY($1::text[])",
      [
        userIds
      ]
    );

  return new Map(
    result.rows.map(
      row => [
        row.user_id,
        row.primary_language
      ]
    )
  );
}

function inferPrimaryFromRoles(
  member,
  savedMap
) {
  const saved =
    savedMap.get(
      member.id
    );

  if (
    saved &&
    LANGUAGE_CHANNELS[
      saved
    ]
  ) {
    return saved;
  }

  const owned =
    LANGUAGE_KEYS.filter(
      key =>
        member.roles.cache.has(
          LANGUAGE_CHANNELS[
            key
          ].role
        )
    );

  if (
    owned.length === 1
  ) {
    return owned[0];
  }

  if (
    owned.includes(
      "english"
    )
  ) {
    return "english";
  }

  return (
    owned[0] ||
    "english"
  );
}

// =====================================================
// ONBOARDING UI
// =====================================================

function languageMenu(
  customId =
    "onboard_language"
) {
  return new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(
          customId
        )
        .setPlaceholder(
          "🌎 Choose your language"
        )
        .addOptions(
          Object.entries(
            LANGUAGES
          ).map(
            ([key, item]) => ({
              label:
                item.name,

              value:
                key,

              emoji:
                item.emoji
            })
          )
        )
    );
}

function reminderMenu(
  language
) {
  return new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(
          "onboard_reminders"
        )
        .setPlaceholder(
          TEXT[
            language
          ].reminders
        )
        .setMinValues(
          1
        )
        .setMaxValues(
          8
        )
        .addOptions(
          ...Object.entries(
            REMINDERS
          ).map(
            ([key, item]) => ({
              label:
                item.name,

              value:
                key,

              emoji:
                item.emoji
            })
          ),

          {
            label:
              "No reminders",

            value:
              "none",

            emoji:
              "🔕"
          }
        )
    );
}

function playstyleMenu(
  language
) {
  return new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(
          "onboard_playstyle"
        )
        .setPlaceholder(
          TEXT[
            language
          ].playstyle
        )
        .addOptions(
          {
            label:
              "Casual",

            value:
              "casual",

            emoji:
              "🌿"
          },

          {
            label:
              "Competitive",

            value:
              "competitive",

            emoji:
              "⚔️"
          },

          {
            label:
              "Both",

            value:
              "both",

            emoji:
              "🎮"
          },

          {
            label:
              "Skip",

            value:
              "skip",

            emoji:
              "⏭️"
          }
        )
    );
}

function socialMenu(
  language
) {
  return new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(
          "onboard_social"
        )
        .setPlaceholder(
          TEXT[
            language
          ].social
        )
        .addOptions(
          {
            label:
              "Chatty",

            value:
              "chatty",

            emoji:
              "💬"
          },

          {
            label:
              "Quiet",

            value:
              "quiet",

            emoji:
              "🌙"
          },

          {
            label:
              "Either",

            value:
              "either",

            emoji:
              "✨"
          },

          {
            label:
              "Skip",

            value:
              "skip",

            emoji:
              "⏭️"
          }
        )
    );
}

function finishButton(
  language
) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          "onboard_finish"
        )
        .setLabel(
          TEXT[
            language
          ].finish
        )
        .setEmoji(
          "✅"
        )
        .setStyle(
          ButtonStyle.Success
        )
    );
}
// =====================================================
// START HERE / ONBOARDING / HELP / PREFERENCES
// =====================================================

async function setupStartHere() {
  const channel =
    await client.channels.fetch(
      CHANNELS.START_HERE
    );

  if (
    !channel?.isTextBased()
  ) {
    return;
  }

  const messages =
    await channel.messages.fetch({
      limit: 50
    });

  const old =
    messages.find(
      m =>
        m.author.id ===
          client.user.id &&
        m.content.includes(
          "VESTRA_START_HERE"
        )
    );

  if (old) {
    return;
  }

  await channel.send({
    content:
      "**VESTRA_START_HERE**\n\n" +

      "# 🖤 Welcome to Ashen Warriors\n\n" +

      `**1. Read the Rules** — <#${CHANNELS.RULES}>\n` +
      `**2. Complete Onboarding** — <#${CHANNELS.ONBOARDING}>\n` +
      `**3. Manage Your Vestra Settings** — <#${CHANNELS.PREFERENCES}>\n` +
      `**4. Need Help?** — <#${CHANNELS.HELP}>\n` +
      `**5. Introductions** — <#${CHANNELS.INTRODUCTIONS}>\n\n` +

      "🌎 General language chats are automatically mirrored and translated.\n" +
      "🌐 Social channels use Vestra's private Translate button.\n" +
      "🔔 Your primary notification language controls where Vestra sends your event alerts.\n\n" +

      "Welcome home. 🖤"
  });
}

async function setupOnboardingPanel() {
  const channel =
    await client.channels.fetch(
      CHANNELS.ONBOARDING
    );

  if (
    !channel?.isTextBased()
  ) {
    return;
  }

  const messages =
    await channel.messages.fetch({
      limit: 50
    });

  const old =
    messages.find(
      m =>
        m.author.id ===
          client.user.id &&
        m.content.includes(
          "VESTRA_ONBOARDING_PANEL"
        )
    );

  if (old) {
    return;
  }

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            "start_onboarding"
          )
          .setLabel(
            "Start Onboarding"
          )
          .setEmoji(
            "🌎"
          )
          .setStyle(
            ButtonStyle.Primary
          )
      );

  await channel.send({
    content:
      "**VESTRA_ONBOARDING_PANEL**\n\n" +

      "# 🖤 Ashen Warriors Onboarding\n\n" +

      "Choose your primary language first. Vestra will use it for your onboarding and notification language.",

    components: [
      row
    ]
  });
}

const preferenceMessages = {
  languages: null,
  reminders: null,
  playstyle: null,
  social: null
};

async function createPreferenceMessage(
  channel,
  marker,
  text,
  emojis
) {
  const messages =
    await channel.messages.fetch({
      limit: 100
    });

  let message =
    messages.find(
      m =>
        m.author.id ===
          client.user.id &&
        m.content.includes(
          marker
        )
    );

  if (!message) {
    message =
      await channel.send(
        text
      );
  }

  for (
    const emoji of
    emojis
  ) {
    try {
      await message.react(
        emoji
      );

    } catch (error) {
      console.error(
        `❌ Reaction ${emoji} failed:`,
        error.message
      );
    }
  }

  return message;
}

async function setupPreferences() {
  const channel =
    await client.channels.fetch(
      CHANNELS.PREFERENCES
    );

  if (
    !channel?.isTextBased()
  ) {
    return;
  }

  preferenceMessages.languages =
    await createPreferenceMessage(
      channel,

      "VESTRA_LANG_PREF",

      "**VESTRA_LANG_PREF**\n\n" +
      "# 🌎 Language Access\n" +
      "React to every language chat you want access to.\n\n" +
      "🇺🇸 English\n" +
      "🇪🇸 Spanish\n" +
      "🇫🇷 French\n" +
      "🇩🇪 German\n" +
      "🇵🇹 Portuguese\n" +
      "🇯🇵 Japanese",

      Object.values(
        LANGUAGES
      ).map(
        x => x.emoji
      )
    );

  preferenceMessages.reminders =
    await createPreferenceMessage(
      channel,

      "VESTRA_REMINDER_PREF",

      "**VESTRA_REMINDER_PREF**\n\n" +
      "# 🔔 Game Reminder Pings\n" +
      "React to every reminder you want. Vestra sends the actual alert in your primary notification language.\n\n" +
      "🔄 Reset\n" +
      "🌅 Morning Conquest\n" +
      "🌌 Night Conquest\n" +
      "🔔 Clash Opening Call\n" +
      "⚔️ Clash Battle Call\n" +
      "🚨 Clash Final Call\n" +
      "⏰ Guild Clash Registration",

      Object.values(
        REMINDERS
      ).map(
        x => x.emoji
      )
    );

  preferenceMessages.playstyle =
    await createPreferenceMessage(
      channel,

      "VESTRA_PLAYSTYLE_PREF",

      "**VESTRA_PLAYSTYLE_PREF**\n\n" +
      "# 🎮 Playstyle\n" +
      "Choose one.\n\n" +
      "🌿 Casual\n" +
      "⚔️ Competitive\n" +
      "🎮 Both",

      Object.values(
        PLAYSTYLE
      ).map(
        x => x.emoji
      )
    );

  preferenceMessages.social =
    await createPreferenceMessage(
      channel,

      "VESTRA_SOCIAL_PREF",

      "**VESTRA_SOCIAL_PREF**\n\n" +
      "# 💬 Social Preference\n" +
      "Choose one.\n\n" +
      "💬 Chatty\n" +
      "🌙 Quiet\n" +
      "✨ Either",

      Object.values(
        SOCIAL
      ).map(
        x => x.emoji
      )
    );

  const messages =
    await channel.messages.fetch({
      limit: 100
    });

  const settingsOld =
    messages.find(
      m =>
        m.author.id ===
          client.user.id &&
        m.content.includes(
          "VESTRA_SETTINGS_PANEL"
        )
    );

  if (!settingsOld) {
    const row =
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(
              "settings_open"
            )
            .setLabel(
              "Open My Vestra Settings"
            )
            .setEmoji(
              "✨"
            )
            .setStyle(
              ButtonStyle.Primary
            ),

          new ButtonBuilder()
            .setCustomId(
              "settings_card"
            )
            .setLabel(
              "My Vestra Card"
            )
            .setEmoji(
              "👤"
            )
            .setStyle(
              ButtonStyle.Secondary
            )
        );

    await channel.send({
      content:
        "**VESTRA_SETTINGS_PANEL**\n\n" +

        "# ✨ Vestra Settings\n" +

        "Manage language access, your primary notification language, game pings, tournament vote alerts, playstyle, and social preference.",

      components: [
        row
      ]
    });
  }

  console.log(
    "✅ Preference panels and Vestra settings ready."
  );
}

async function setupHelpCenter() {
  const channel =
    await client.channels.fetch(
      CHANNELS.HELP
    );

  if (
    !channel?.isTextBased()
  ) {
    return;
  }

  const messages =
    await channel.messages.fetch({
      limit: 50
    });

  const old =
    messages.find(
      m =>
        m.author.id ===
          client.user.id &&
        m.content.includes(
          "VESTRA_HELP_CENTER"
        )
    );

  if (old) {
    console.log(
      "✅ Help Center ready."
    );

    return;
  }

  const row1 =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            "help_game"
          )
          .setLabel(
            "Game Help"
          )
          .setEmoji(
            "🎮"
          )
          .setStyle(
            ButtonStyle.Primary
          ),

        new ButtonBuilder()
          .setCustomId(
            "help_team"
          )
          .setLabel(
            "Need a Team"
          )
          .setEmoji(
            "👥"
          )
          .setStyle(
            ButtonStyle.Primary
          ),

        new ButtonBuilder()
          .setCustomId(
            "help_staff"
          )
          .setLabel(
            "Ask Staff"
          )
          .setEmoji(
            "🛡️"
          )
          .setStyle(
            ButtonStyle.Danger
          ),

        new ButtonBuilder()
          .setCustomId(
            "help_discord"
          )
          .setLabel(
            "Discord Help"
          )
          .setEmoji(
            "⚙️"
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  const row2 =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            "help_faq"
          )
          .setLabel(
            "FAQ"
          )
          .setEmoji(
            "❓"
          )
          .setStyle(
            ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            "help_guide"
          )
          .setLabel(
            "Server Guide"
          )
          .setEmoji(
            "🧭"
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  await channel.send({
    content:
      "**VESTRA_HELP_CENTER**\n\n" +

      "# 🖤 Ashen Help Center\n\n" +

      "🎮 **Game Help** — Ask the community for help\n" +
      "👥 **Need a Team** — Find people to play with\n" +
      "🛡️ **Ask Staff** — Privately contact Ashen staff\n" +
      "⚙️ **Discord Help** — Get help with the server\n" +
      "❓ **FAQ** — Common questions\n" +
      "🧭 **Server Guide** — Learn where everything is",

    components: [
      row1,
      row2
    ]
  });

  console.log(
    "✅ Help Center ready."
  );
}

function createHelpModal(
  customId,
  title,
  label,
  placeholder
) {
  const modal =
    new ModalBuilder()
      .setCustomId(
        customId
      )
      .setTitle(
        title
      );

  const input =
    new TextInputBuilder()
      .setCustomId(
        "help_details"
      )
      .setLabel(
        label
      )
      .setPlaceholder(
        placeholder
      )
      .setStyle(
        TextInputStyle.Paragraph
      )
      .setMinLength(
        5
      )
      .setMaxLength(
        1000
      )
      .setRequired(
        true
      );

  modal.addComponents(
    new ActionRowBuilder()
      .addComponents(
        input
      )
  );

  return modal;
}

async function createHelpThread(
  interaction,
  type,
  emoji,
  details
) {
  const channel =
    await interaction.guild.channels.fetch(
      CHANNELS.HELP
    );

  if (
    !channel?.isTextBased()
  ) {
    await interaction.reply({
      content:
        "❌ Vestra couldn't access the help channel.",

      flags:
        MessageFlags.Ephemeral
    });

    return;
  }

  const post =
    await channel.send({
      content:
        `${emoji} **${type}**\n\n` +
        `**From:** ${interaction.member}\n\n` +
        `${details}`
    });

  const safeName =
    `${type}-${interaction.user.username}`
      .replace(
        /[^a-zA-Z0-9-_]/g,
        "-"
      )
      .slice(
        0,
        90
      );

  const thread =
    await post.startThread({
      name:
        safeName,

      autoArchiveDuration:
        1440
    });

  await thread.send({
    content:
      `${interaction.member}, your help thread is ready! 🖤`
  });

  await interaction.reply({
    content:
      `✅ Your request has been posted: ${thread}`,

    flags:
      MessageFlags.Ephemeral
  });
}

// =====================================================
// WELCOME / MEMBER CARDS
// =====================================================

function welcomeCard(
  member,
  languageName,
  playstyleName,
  socialName
) {
  return new EmbedBuilder()
    .setTitle(
      "🖤 A New Ashen Warrior Has Arrived"
    )
    .setDescription(
      `Welcome **${member.displayName}** to Ashen Warriors!`
    )
    .setThumbnail(
      member.user.displayAvatarURL({
        size: 256
      })
    )
    .addFields(
      {
        name:
          "🌎 Language",

        value:
          languageName,

        inline:
          true
      },

      {
        name:
          "🎮 Playstyle",

        value:
          playstyleName,

        inline:
          true
      },

      {
        name:
          "💬 Social",

        value:
          socialName,

        inline:
          true
      }
    )
    .setFooter({
      text:
        "Vestra • Ashen Warriors"
    })
    .setTimestamp();
}

async function memberCardEmbed(
  member
) {
  const primary =
    await inferPrimaryLanguage(
      member
    );

  const languageAccess =
    LANGUAGE_KEYS
      .filter(
        key =>
          member.roles.cache.has(
            LANGUAGE_CHANNELS[
              key
            ].role
          )
      )
      .map(
        key =>
          `${LANGUAGE_CHANNELS[key].emoji} ${LANGUAGE_CHANNELS[key].name}`
      );

  const reminderNames =
    Object.values(
      REMINDERS
    )
      .filter(
        item =>
          member.roles.cache.has(
            item.role
          )
      )
      .map(
        item =>
          item.name
      );

  const tourneys =
    Object.values(
      TOURNAMENTS
    )
      .filter(
        item =>
          member.roles.cache.has(
            item.role
          )
      )
      .map(
        item =>
          item.name
      );

  const playstyle =
    Object.values(
      PLAYSTYLE
    ).find(
      item =>
        member.roles.cache.has(
          item.role
        )
    )?.name ||
    "Not set";

  const social =
    Object.values(
      SOCIAL
    ).find(
      item =>
        member.roles.cache.has(
          item.role
        )
    )?.name ||
    "Not set";

  return new EmbedBuilder()
    .setTitle(
      `👤 ${member.displayName}'s Vestra Card`
    )
    .setThumbnail(
      member.user.displayAvatarURL({
        size: 256
      })
    )
    .addFields(
      {
        name:
          "🔔 Primary Notification Language",

        value:
          `${LANGUAGE_CHANNELS[primary].emoji} ${LANGUAGE_CHANNELS[primary].name}`
      },

      {
        name:
          "🌎 Language Access",

        value:
          languageAccess.join(
            " • "
          ) ||
          "None"
      },

      {
        name:
          "🎮 Playstyle",

        value:
          playstyle,

        inline:
          true
      },

      {
        name:
          "💬 Social",

        value:
          social,

        inline:
          true
      },

      {
        name:
          "🔔 Game Pings",

        value:
          reminderNames.join(
            ", "
          ) ||
          "None"
      },

      {
        name:
          "🏆 Tournament Vote Pings",

        value:
          tourneys.join(
            ", "
          ) ||
          "None"
      }
    )
    .setFooter({
      text:
        "Vestra • Ashen Warriors"
    });
}

// =====================================================
// SETTINGS PANEL
// =====================================================

function settingsHomeComponents() {
  return [
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            "settings_languages"
          )
          .setLabel(
            "Language Access"
          )
          .setEmoji(
            "🌎"
          )
          .setStyle(
            ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            "settings_notify"
          )
          .setLabel(
            "Notification Language"
          )
          .setEmoji(
            "🔔"
          )
          .setStyle(
            ButtonStyle.Primary
          ),

        new ButtonBuilder()
          .setCustomId(
            "settings_reminders"
          )
          .setLabel(
            "Game Pings"
          )
          .setEmoji(
            "⏰"
          )
          .setStyle(
            ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            "settings_tournaments"
          )
          .setLabel(
            "Tournament Pings"
          )
          .setEmoji(
            "🏆"
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      ),

    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            "settings_playstyle"
          )
          .setLabel(
            "Playstyle"
          )
          .setEmoji(
            "🎮"
          )
          .setStyle(
            ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            "settings_social"
          )
          .setLabel(
            "Social"
          )
          .setEmoji(
            "💬"
          )
          .setStyle(
            ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            "settings_card"
          )
          .setLabel(
            "My Vestra Card"
          )
          .setEmoji(
            "👤"
          )
          .setStyle(
            ButtonStyle.Success
          )
      )
  ];
}

function settingsHomeEmbed() {
  return new EmbedBuilder()
    .setTitle(
      "✨ My Vestra Settings"
    )
    .setDescription(
      "Choose what you want to manage. Your **Notification Language** controls where Vestra sends your personal event alerts."
    )
    .setFooter({
      text:
        "Changes save immediately."
    });
}

function backButtonRow() {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          "settings_back"
        )
        .setLabel(
          "Back"
        )
        .setEmoji(
          "↩️"
        )
        .setStyle(
          ButtonStyle.Secondary
        )
    );
}

async function updateSingleChoiceRole(
  member,
  group,
  selectedKey
) {
  for (
    const [
      key,
      item
    ] of Object.entries(
      group
    )
  ) {
    if (
      member.roles.cache.has(
        item.role
      ) &&
      key !== selectedKey
    ) {
      await member.roles.remove(
        item.role
      ).catch(
        () => {}
      );
    }
  }

  if (
    selectedKey &&
    group[selectedKey]
  ) {
    await member.roles.add(
      group[
        selectedKey
      ].role
    );
  }
}

// =====================================================
// TRANSLATION WEBHOOKS / PERSISTENT MAPPING
// =====================================================

const translationWebhooks =
  new Map();

const destinationChains =
  new Map(
    LANGUAGE_KEYS.map(
      key => [
        key,
        Promise.resolve()
      ]
    )
  );

async function getTranslationWebhook(
  channel
) {
  if (
    translationWebhooks.has(
      channel.id
    )
  ) {
    return translationWebhooks.get(
      channel.id
    );
  }

  const webhooks =
    await channel.fetchWebhooks();

  let webhook =
    webhooks.find(
      hook =>
        hook.owner?.id ===
          client.user.id &&
        hook.name ===
          "Vestra Translator"
    );

  if (!webhook) {
    webhook =
      await channel.createWebhook({
        name:
          "Vestra Translator"
      });
  }

  translationWebhooks.set(
    channel.id,
    webhook
  );

  return webhook;
}

function queueDestination(
  languageKey,
  task
) {
  const previous =
    destinationChains.get(
      languageKey
    ) ||
    Promise.resolve();

  const next =
    previous
      .then(
        task
      )
      .catch(
        error => {
          console.error(
            `❌ ${languageKey} translation queue:`,
            error.message
          );
        }
      );

  destinationChains.set(
    languageKey,
    next
  );

  return next;
}

async function getGroupByMessageId(
  messageId
) {
  const result =
    await pool.query(
      `SELECT
         tm.*,
         tg.source_message_id,
         tg.source_channel_id,
         tg.source_language,
         tg.author_id,
         tg.author_name,
         tg.author_avatar,
         tg.original_content,
         tg.attachment_urls,
         tg.reply_to_group_id
       FROM translation_messages tm
       JOIN translation_groups tg
         ON tg.group_id = tm.group_id
       WHERE tm.message_id = $1`,
      [
        messageId
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function getTargetCopy(
  groupId,
  languageKey
) {
  const result =
    await pool.query(
      "SELECT * FROM translation_messages WHERE group_id = $1 AND language_key = $2",
      [
        groupId,
        languageKey
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function buildReplyHeader(
  replyToGroupId,
  targetLanguage,
  guildId
) {
  if (!replyToGroupId) {
    return "";
  }

  const copy =
    await getTargetCopy(
      replyToGroupId,
      targetLanguage
    );

  if (!copy) {
    return "↪️ **Reply**\n";
  }

  const jump =
    `https://discord.com/channels/${guildId}/${copy.channel_id}/${copy.message_id}`;

  return (
    `↪️ [**Replying to this message**](<${jump}>)\n`
  );
}

async function reactionSummary(
  groupId
) {
  const result =
    await pool.query(
      `SELECT
         emoji_key,
         COUNT(DISTINCT user_id)::int AS count
       FROM message_reactions
       WHERE group_id = $1
       GROUP BY emoji_key
       ORDER BY count DESC, emoji_key ASC`,
      [
        groupId
      ]
    );

  if (
    !result.rows.length
  ) {
    return "";
  }

  return (
    `\n\n—\n${
      result.rows
        .map(
          row =>
            `${row.emoji_key} ${row.count}`
        )
        .join(
          "   "
        )
    }`
  );
}

async function editTranslatedCopy(
  row,
  content,
  allowedMentions = {
    parse: []
  }
) {
  const channel =
    await client.channels.fetch(
      row.channel_id
    ).catch(
      () => null
    );

  if (
    !channel?.isTextBased()
  ) {
    return;
  }

  const webhook =
    await getTranslationWebhook(
      channel
    );

  try {
    await webhook.editMessage(
      row.message_id,
      {
        content:
          limitText(
            content,
            1990
          ),

        allowedMentions
      }
    );

  } catch (error) {
    if (
      error?.code ===
      10008
    ) {
      await pool.query(
        "DELETE FROM translation_messages WHERE message_id = $1",
        [
          row.message_id
        ]
      );

    } else {
      throw error;
    }
  }
}

async function createTranslatedCopy(
  message,
  groupId,
  sourceKey,
  targetKey,
  replyToGroupId
) {
  const targetInfo =
    LANGUAGE_CHANNELS[
      targetKey
    ];

  const sourceInfo =
    LANGUAGE_CHANNELS[
      sourceKey
    ];

  const targetChannel =
    await client.channels.fetch(
      targetInfo.channel
    );

  if (
    !targetChannel?.isTextBased()
  ) {
    throw new Error(
      `${targetInfo.name} channel unavailable`
    );
  }

  let translated =
    message.content || "";

  if (message.content) {
    translated =
      await googleTranslate(
        message.content,
        targetInfo.code,
        sourceInfo.code
      );
  }

  const replyHeader =
    await buildReplyHeader(
      replyToGroupId,
      targetKey,
      message.guild.id
    );

  const attachments =
    formatAttachments(
      message.attachments
    );

  let base =
    [
      replyHeader.trimEnd(),
      translated,
      attachments
    ]
      .filter(
        Boolean
      )
      .join(
        "\n"
      );

  base =
    limitText(
      base,
      1850
    );

  const webhook =
    await getTranslationWebhook(
      targetChannel
    );

  const mentions =
    getMentionIds(
      message.content || ""
    );

  const summary =
    await reactionSummary(
      groupId
    );

  const sent =
    await webhook.send({
      content:
        `${base}${summary}`,

      username:
        `${safeDisplayName(
          message.member,
          message.author
        )} • ${sourceInfo.emoji}`,

      avatarURL:
        message.author.displayAvatarURL({
          extension:
            "png",

          size:
            256
        }),

      allowedMentions: {
        parse: [],

        users:
          mentions.users,

        roles:
          mentions.roles
      }
    });

  await pool.query(
    `INSERT INTO translation_messages(
       message_id,
       group_id,
       channel_id,
       language_key,
       is_source,
       base_content,
       webhook_id
     )
     VALUES(
       $1,
       $2,
       $3,
       $4,
       FALSE,
       $5,
       $6
     )
     ON CONFLICT(
       group_id,
       language_key
     )
     DO UPDATE SET
       message_id = EXCLUDED.message_id,
       channel_id = EXCLUDED.channel_id,
       base_content = EXCLUDED.base_content,
       webhook_id = EXCLUDED.webhook_id`,

    [
      sent.id,
      groupId,
      targetInfo.channel,
      targetKey,
      base,
      webhook.id
    ]
  );

  console.log(
    `✅ Google translation ${sourceInfo.name} → ${targetInfo.name}: ${message.author.username}`
  );
}
async function handleGeneralMessageCreate(
  message
) {
  const sourceEntry =
    languageByChannel(
      message.channel.id
    );

  if (!sourceEntry) {
    return;
  }

  const [
    sourceKey
  ] =
    sourceEntry;

  if (
    !message.content &&
    message.attachments.size ===
      0
  ) {
    return;
  }

  let replyToGroupId =
    null;

  if (
    message.reference
      ?.messageId
  ) {
    const referenced =
      await getGroupByMessageId(
        message.reference.messageId
      ).catch(
        () => null
      );

    replyToGroupId =
      referenced?.group_id ||
      null;
  }

  const attachmentURLs =
    [
      ...message.attachments.values()
    ].map(
      a => a.url
    );

  await pool.query(
    `INSERT INTO translation_groups(
       group_id,
       source_message_id,
       source_channel_id,
       source_language,
       author_id,
       author_name,
       author_avatar,
       original_content,
       attachment_urls,
       reply_to_group_id
     )
     VALUES(
       $1,
       $2,
       $3,
       $4,
       $5,
       $6,
       $7,
       $8,
       $9::jsonb,
       $10
     )
     ON CONFLICT(group_id)
     DO NOTHING`,

    [
      message.id,
      message.id,
      message.channel.id,
      sourceKey,
      message.author.id,
      safeDisplayName(
        message.member,
        message.author
      ),
      message.author.displayAvatarURL({
        extension:
          "png",

        size:
          256
      }),
      message.content || "",
      JSON.stringify(
        attachmentURLs
      ),
      replyToGroupId
    ]
  );

  await pool.query(
    `INSERT INTO translation_messages(
       message_id,
       group_id,
       channel_id,
       language_key,
       is_source,
       base_content
     )
     VALUES(
       $1,
       $2,
       $3,
       $4,
       TRUE,
       $5
     )
     ON CONFLICT(message_id)
     DO NOTHING`,

    [
      message.id,
      message.id,
      message.channel.id,
      sourceKey,
      message.content || ""
    ]
  );

  for (
    const targetKey of
    LANGUAGE_KEYS
  ) {
    if (
      targetKey ===
      sourceKey
    ) {
      continue;
    }

    queueDestination(
      targetKey,

      () =>
        createTranslatedCopy(
          message,
          message.id,
          sourceKey,
          targetKey,
          replyToGroupId
        )
    );
  }
}

async function handleGeneralMessageUpdate(
  message
) {
  const mapping =
    await getGroupByMessageId(
      message.id
    );

  if (
    !mapping?.is_source
  ) {
    return;
  }

  const sourceKey =
    mapping.source_language;

  const attachmentURLs =
    [
      ...message.attachments.values()
    ].map(
      a => a.url
    );

  await pool.query(
    `UPDATE translation_groups
     SET
       original_content = $2,
       attachment_urls = $3::jsonb
     WHERE group_id = $1`,

    [
      mapping.group_id,
      message.content || "",
      JSON.stringify(
        attachmentURLs
      )
    ]
  );

  const copies =
    await pool.query(
      "SELECT * FROM translation_messages WHERE group_id = $1 AND is_source = FALSE",
      [
        mapping.group_id
      ]
    );

  const summary =
    await reactionSummary(
      mapping.group_id
    );

  for (
    const copy of
    copies.rows
  ) {
    queueDestination(
      copy.language_key,

      async () => {
        const targetInfo =
          LANGUAGE_CHANNELS[
            copy.language_key
          ];

        const sourceInfo =
          LANGUAGE_CHANNELS[
            sourceKey
          ];

        let translated =
          message.content || "";

        if (
          message.content
        ) {
          translated =
            await googleTranslate(
              message.content,
              targetInfo.code,
              sourceInfo.code
            );
        }

        const replyHeader =
          await buildReplyHeader(
            mapping.reply_to_group_id,
            copy.language_key,
            message.guild.id
          );

        const attachments =
          formatAttachments(
            message.attachments
          );

        const base =
          limitText(
            [
              replyHeader.trimEnd(),
              translated,
              attachments
            ]
              .filter(
                Boolean
              )
              .join(
                "\n"
              ),
            1850
          );

        const mentions =
          getMentionIds(
            message.content ||
            ""
          );

        await pool.query(
          "UPDATE translation_messages SET base_content = $2 WHERE message_id = $1",
          [
            copy.message_id,
            base
          ]
        );

        await editTranslatedCopy(
          copy,
          `${base}${summary}`,
          {
            parse: [],

            users:
              mentions.users,

            roles:
              mentions.roles
          }
        );
      }
    );
  }

  console.log(
    `✏️ Synced edit across translations: ${message.id}`
  );
}

async function deleteTranslatedGroup(
  groupId
) {
  const copies =
    await pool.query(
      "SELECT * FROM translation_messages WHERE group_id = $1 AND is_source = FALSE",
      [
        groupId
      ]
    );

  for (
    const row of
    copies.rows
  ) {
    const channel =
      await client.channels.fetch(
        row.channel_id
      ).catch(
        () => null
      );

    if (
      !channel?.isTextBased()
    ) {
      continue;
    }

    try {
      const webhook =
        await getTranslationWebhook(
          channel
        );

      await webhook.deleteMessage(
        row.message_id
      );

    } catch {}
  }

  await pool.query(
    "DELETE FROM translation_groups WHERE group_id = $1",
    [
      groupId
    ]
  );
}

async function updateReactionSummaries(
  groupId
) {
  const summary =
    await reactionSummary(
      groupId
    );

  const copies =
    await pool.query(
      "SELECT * FROM translation_messages WHERE group_id = $1 AND is_source = FALSE",
      [
        groupId
      ]
    );

  for (
    const row of
    copies.rows
  ) {
    await editTranslatedCopy(
      row,
      `${row.base_content || ""}${summary}`
    ).catch(
      error => {
        console.error(
          "❌ Reaction summary update:",
          error.message
        );
      }
    );
  }
}

// =====================================================
// SOCIAL TRANSLATE COMPANIONS
// =====================================================

function isSocialChannel(
  channel
) {
  return (
    SOCIAL_CHANNELS.has(
      channel.id
    ) ||
    channel.parentId ===
      SOCIAL_CATEGORY_ID
  );
}

async function createSocialCompanion(
  message
) {
  if (
    !message.content ||
    !hasTranslatableText(
      message.content
    )
  ) {
    return;
  }

  const button =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `social_translate:${message.id}`
          )
          .setLabel(
            "Translate"
          )
          .setEmoji(
            "🌐"
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  const companion =
    await message.reply({
      content:
        "🌐 **Translate with Vestra**",

      components: [
        button
      ],

      allowedMentions: {
        repliedUser:
          false
      }
    });

  await pool.query(
    `INSERT INTO social_companions(
       original_message_id,
       channel_id,
       companion_message_id,
       author_id
     )
     VALUES($1,$2,$3,$4)
     ON CONFLICT(original_message_id)
     DO UPDATE SET
       companion_message_id = EXCLUDED.companion_message_id`,

    [
      message.id,
      message.channel.id,
      companion.id,
      message.author.id
    ]
  );
}

async function deleteSocialCompanion(
  originalMessageId
) {
  const result =
    await pool.query(
      "SELECT * FROM social_companions WHERE original_message_id = $1",
      [
        originalMessageId
      ]
    );

  const row =
    result.rows[0];

  if (!row) {
    return;
  }

  const channel =
    await client.channels.fetch(
      row.channel_id
    ).catch(
      () => null
    );

  if (
    channel?.isTextBased()
  ) {
    const companion =
      await channel.messages.fetch(
        row.companion_message_id
      ).catch(
        () => null
      );

    if (companion) {
      await companion.delete()
        .catch(
          () => {}
        );
    }
  }

  await pool.query(
    "DELETE FROM social_companions WHERE original_message_id = $1",
    [
      originalMessageId
    ]
  );
}

// =====================================================
// COMMUNITY HIGHLIGHTS / STARBOARD
// =====================================================

function reactionStringFromMessage(
  message
) {
  const entries =
    [
      ...message.reactions.cache.values()
    ]
      .map(
        reaction => ({
          emoji:
            emojiKey(
              reaction.emoji
            ),

          count:
            reaction.count ||
            0
        })
      )
      .filter(
        x =>
          x.count >
          0
      )
      .sort(
        (a, b) =>
          b.count -
          a.count
      );

  return entries
    .map(
      x =>
        `${x.emoji} ${x.count}`
    )
    .join(
      "   "
    );
}

async function upsertHighlight(
  sourceMessage,
  score,
  reactionText = ""
) {
  if (
    !sourceMessage ||
    sourceMessage.author?.bot
  ) {
    return;
  }

  if (
    sourceMessage.channel.id ===
    CHANNELS.HIGHLIGHTS
  ) {
    return;
  }

  const highlightChannel =
    await client.channels.fetch(
      CHANNELS.HIGHLIGHTS
    ).catch(
      () => null
    );

  if (
    !highlightChannel?.isTextBased()
  ) {
    return;
  }

  const existing =
    await pool.query(
      "SELECT * FROM highlights WHERE source_message_id = $1",
      [
        sourceMessage.id
      ]
    );

  const firstImage =
    [
      ...sourceMessage.attachments.values()
    ].find(
      a =>
        a.contentType?.startsWith(
          "image/"
        )
    );

  const embed =
    new EmbedBuilder()
      .setAuthor({
        name:
          safeDisplayName(
            sourceMessage.member,
            sourceMessage.author
          ),

        iconURL:
          sourceMessage.author.displayAvatarURL({
            size: 128
          })
      })
      .setDescription(
        limitText(
          sourceMessage.content ||
            "*(attachment / media post)*",
          3500
        )
      )
      .addFields(
        {
          name:
            "✨ Community Love",

          value:
            reactionText ||
            `${score} reactions`,

          inline:
            true
        },

        {
          name:
            "🔗 Original",

          value:
            `[Jump to message](${sourceMessage.url})`,

          inline:
            true
        }
      )
      .setFooter({
        text:
          "Ashen Community Highlights • Vestra"
      })
      .setTimestamp(
        sourceMessage.createdAt
      );

  if (firstImage) {
    embed.setImage(
      firstImage.url
    );
  }

  if (
    existing.rows[0]
  ) {
    const highlight =
      await highlightChannel.messages.fetch(
        existing.rows[0]
          .highlight_message_id
      ).catch(
        () => null
      );

    if (highlight) {
      await highlight.edit({
        embeds: [
          embed
        ]
      }).catch(
        () => {}
      );

      await pool.query(
        "UPDATE highlights SET score = $2 WHERE source_message_id = $1",
        [
          sourceMessage.id,
          score
        ]
      );

      return;
    }
  }

  const sent =
    await highlightChannel.send({
      embeds: [
        embed
      ]
    });

  await pool.query(
    `INSERT INTO highlights(
       source_message_id,
       highlight_message_id,
       source_channel_id,
       score
     )
     VALUES($1,$2,$3,$4)
     ON CONFLICT(source_message_id)
     DO UPDATE SET
       highlight_message_id = EXCLUDED.highlight_message_id,
       score = EXCLUDED.score`,

    [
      sourceMessage.id,
      sent.id,
      sourceMessage.channel.id,
      score
    ]
  );
}

async function removeHighlight(
  sourceMessageId
) {
  const result =
    await pool.query(
      "SELECT * FROM highlights WHERE source_message_id = $1",
      [
        sourceMessageId
      ]
    );

  const row =
    result.rows[0];

  if (!row) {
    return;
  }

  const channel =
    await client.channels.fetch(
      CHANNELS.HIGHLIGHTS
    ).catch(
      () => null
    );

  if (
    channel?.isTextBased()
  ) {
    const message =
      await channel.messages.fetch(
        row.highlight_message_id
      ).catch(
        () => null
      );

    if (message) {
      await message.delete()
        .catch(
          () => {}
        );
    }
  }

  await pool.query(
    "DELETE FROM highlights WHERE source_message_id = $1",
    [
      sourceMessageId
    ]
  );
}

async function maybeHighlightGroup(
  groupId
) {
  const reactions =
    await pool.query(
      `SELECT
         emoji_key,
         COUNT(DISTINCT user_id)::int AS count
       FROM message_reactions
       WHERE group_id = $1
       GROUP BY emoji_key
       ORDER BY count DESC, emoji_key ASC`,
      [
        groupId
      ]
    );

  const total =
    reactions.rows.reduce(
      (
        sum,
        row
      ) =>
        sum +
        Number(
          row.count ||
          0
        ),
      0
    );

  if (
    total <
    HIGHLIGHT_REACTION_THRESHOLD
  ) {
    return;
  }

  const reactionText =
    reactions.rows
      .map(
        row =>
          `${row.emoji_key} ${row.count}`
      )
      .join(
        "   "
      );

  const group =
    await pool.query(
      "SELECT * FROM translation_groups WHERE group_id = $1",
      [
        groupId
      ]
    );

  const row =
    group.rows[0];

  if (!row) {
    return;
  }

  const channel =
    await client.channels.fetch(
      row.source_channel_id
    ).catch(
      () => null
    );

  if (
    !channel?.isTextBased()
  ) {
    return;
  }

  const source =
    await channel.messages.fetch(
      row.source_message_id
    ).catch(
      () => null
    );

  if (!source) {
    return;
  }

  await upsertHighlight(
    source,
    total,
    reactionText
  );
}

async function maybeHighlightNative(
  message
) {
  if (
    !message ||
    message.author?.bot
  ) {
    return;
  }

  const total =
    [
      ...message.reactions.cache.values()
    ].reduce(
      (
        sum,
        r
      ) =>
        sum +
        (
          r.count ||
          0
        ),
      0
    );

  if (
    total <
    HIGHLIGHT_REACTION_THRESHOLD
  ) {
    return;
  }

  await upsertHighlight(
    message,
    total,
    reactionStringFromMessage(
      message
    )
  );
}
// =====================================================
// DAYLIGHT SAVING + SCHEDULES
// =====================================================

function nthWeekdayOfMonth(
  year,
  monthIndex,
  weekday,
  nth
) {
  const first =
    new Date(
      Date.UTC(
        year,
        monthIndex,
        1
      )
    );

  const firstWeekday =
    first.getUTCDay();

  const offset =
    (
      weekday -
      firstWeekday +
      7
    ) % 7;

  return (
    1 +
    offset +
    (
      nth - 1
    ) *
      7
  );
}

function isCentralDSTDate(
  year,
  month,
  day
) {
  const marchSecondSunday =
    nthWeekdayOfMonth(
      year,
      2,
      0,
      2
    );

  const novemberFirstSunday =
    nthWeekdayOfMonth(
      year,
      10,
      0,
      1
    );

  if (
    month < 3 ||
    month > 11
  ) {
    return false;
  }

  if (
    month > 3 &&
    month < 11
  ) {
    return true;
  }

  if (
    month === 3
  ) {
    return (
      day >=
      marchSecondSunday
    );
  }

  if (
    month === 11
  ) {
    return (
      day <
      novemberFirstSunday
    );
  }

  return false;
}

function chicagoParts(
  date = new Date()
) {
  const formatter =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          TZ,

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit",

        weekday:
          "short",

        hour:
          "2-digit",

        minute:
          "2-digit",

        second:
          "2-digit",

        hourCycle:
          "h23"
      }
    );

  const values = {};

  for (
    const part of
    formatter.formatToParts(
      date
    )
  ) {
    if (
      part.type !==
      "literal"
    ) {
      values[
        part.type
      ] =
        part.value;
    }
  }

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  return {
    year:
      Number(
        values.year
      ),

    month:
      Number(
        values.month
      ),

    day:
      Number(
        values.day
      ),

    weekday:
      weekdayMap[
        values.weekday
      ],

    hour:
      Number(
        values.hour
      ),

    minute:
      Number(
        values.minute
      ),

    second:
      Number(
        values.second
      )
  };
}

function dateKey(
  parts
) {
  return (
    `${parts.year}-` +

    `${String(
      parts.month
    ).padStart(
      2,
      "0"
    )}-` +

    `${String(
      parts.day
    ).padStart(
      2,
      "0"
    )}`
  );
}

function isNexusSunday(
  year,
  month,
  day
) {
  const anchor =
    Date.UTC(
      2026,
      10,
      8
    );

  const current =
    Date.UTC(
      year,
      month - 1,
      day
    );

  const days =
    Math.floor(
      (
        current -
        anchor
      ) /
      86400000
    );

  return (
    days >= 0 &&
    days % 14 === 0
  );
}

const SCHEDULED_EVENTS = [
  {
    key:
      "reset",

    label:
      "Reset",

    role:
      REMINDERS.reset.role,

    days:
      [0,1,2,3,4,5,6],

    winter:
      [7,0],

    summer:
      [8,0],

    text:
      "🔄 Reset reminder!"
  },

  {
    key:
      "morning",

    label:
      "Morning Conquest",

    role:
      REMINDERS.morning.role,

    days:
      [0,1,2,3,4,5,6],

    winter:
      [10,30],

    summer:
      [11,30],

    text:
      "🌅 Morning Conquest is starting now!"
  },

  {
    key:
      "night",

    label:
      "Night Conquest",

    role:
      REMINDERS.night.role,

    days:
      [0,1,2,3,4,5,6],

    winter:
      [18,30],

    summer:
      [20,30],

    text:
      "🌌 Night Conquest is starting now!"
  },

  {
    key:
      "opening",

    label:
      "Clash Opening Call",

    role:
      REMINDERS.opening.role,

    days:
      [1,3,5],

    winter:
      [9,0],

    summer:
      [10,0],

    text:
      "🔔 Clash Opening Call!"
  },

  {
    key:
      "battle",

    label:
      "Clash Battle Call",

    role:
      REMINDERS.battle.role,

    days:
      [1,3,5],

    winter:
      [15,0],

    summer:
      [16,0],

    text:
      "⚔️ Clash Battle Call!"
  },

  {
    key:
      "final",

    label:
      "Clash Final Call",

    role:
      REMINDERS.final.role,

    days:
      [1,3,5],

    winter:
      [20,30],

    summer:
      [21,30],

    text:
      "🚨 Clash Final Call!"
  },

  {
    key:
      "registration",

    label:
      "Guild Clash Registration",

    role:
      REMINDERS.registration.role,

    days:
      [0,2,4],

    winter:
      [8,30],

    summer:
      [9,30],

    text:
      "⏰ Guild Clash Registration is open!"
  },

  {
    key:
      "sever_pre",

    label:
      "Sever Tournament Vote Reminder",

    role:
      TOURNAMENTS.sever.role,

    days:
      [6],

    winter:
      [14,5],

    summer:
      [15,5],

    text:
      "🗳️ Sever Tournament voting opens in 5 minutes. Get ready to vote!",

    tournament:
      "sever",

    kind:
      "pre"
  },

  {
    key:
      "sever_start",

    label:
      "Sever Tournament Voting",

    days:
      [6],

    winter:
      [14,10],

    summer:
      [15,10],

    tournament:
      "sever",

    kind:
      "start"
  },

  {
    key:
      "nexus_pre",

    label:
      "Nexus Tournament Vote Reminder",

    role:
      TOURNAMENTS.nexus.role,

    days:
      [0],

    winter:
      [15,5],

    summer:
      [16,5],

    text:
      "🗳️ Nexus Tournament voting opens in 5 minutes. Get ready to vote!",

    tournament:
      "nexus",

    kind:
      "pre",

    alternateSunday:
      true
  },

  {
    key:
      "nexus_start",

    label:
      "Nexus Tournament Voting",

    days:
      [0],

    winter:
      [15,10],

    summer:
      [16,10],

    tournament:
      "nexus",

    kind:
      "start",

    alternateSunday:
      true
  }
];

function eventTimeForDate(
  event,
  y,
  m,
  d
) {
  return isCentralDSTDate(
    y,
    m,
    d
  )
    ? event.summer
    : event.winter;
}

function eventApplies(
  event,
  y,
  m,
  d,
  weekday
) {
  if (
    !event.days.includes(
      weekday
    )
  ) {
    return false;
  }

  if (
    event.alternateSunday &&
    !isNexusSunday(
      y,
      m,
      d
    )
  ) {
    return false;
  }

  return true;
}

// =====================================================
// LOCALIZED NOTIFICATION DELIVERY
// =====================================================

async function sendMasterLog(
  roleId,
  label,
  text,
  deliveredCount
) {
  const channel =
    await client.channels.fetch(
      CHANNELS.REMINDERS
    ).catch(
      () => null
    );

  if (
    !channel?.isTextBased()
  ) {
    throw new Error(
      "#guild-pings is unavailable"
    );
  }

  const roleText =
    roleId
      ? `<@&${roleId}> `
      : "";

  await channel.send({
    content:
      `${roleText}**${label}**\n` +
      `${text || ""}\n\n` +
      `🌎 Vestra delivered ${deliveredCount} localized notification${deliveredCount === 1 ? "" : "s"}.`,

    allowedMentions: {
      parse: []
    }
  });
}

async function sendLocalizedRoleNotification(
  roleId,
  englishText,
  label
) {
  const guild =
    getGuild();

  if (!guild) {
    return 0;
  }

  await guild.members.fetch();

  const members =
    guild.members.cache.filter(
      member =>
        !member.user.bot &&
        member.roles.cache.has(
          roleId
        )
    );

  const ids =
    [...members.keys()];

  const prefs =
    await loadPrimaryLanguageMap(
      ids
    );

  const grouped =
    new Map(
      LANGUAGE_KEYS.map(
        key => [
          key,
          []
        ]
      )
    );

  for (
    const member of
    members.values()
  ) {
    const lang =
      inferPrimaryFromRoles(
        member,
        prefs
      );

    grouped.get(
      lang
    )?.push(
      member
    );
  }

  let delivered =
    0;

  for (
    const [
      languageKey,
      recipients
    ] of grouped.entries()
  ) {
    if (
      !recipients.length
    ) {
      continue;
    }

    const info =
      LANGUAGE_CHANNELS[
        languageKey
      ];

    const channel =
      await client.channels.fetch(
        info.channel
      ).catch(
        () => null
      );

    if (
      !channel?.isTextBased()
    ) {
      continue;
    }

    const visible =
      recipients.filter(
        member =>
          channel.permissionsFor(
            member
          )?.has(
            PermissionFlagsBits.ViewChannel
          )
      );

    if (
      !visible.length
    ) {
      continue;
    }

    let localized =
      englishText;

    if (
      languageKey !==
      "english"
    ) {
      try {
        localized =
          await googleTranslate(
            englishText,
            info.code,
            "en"
          );

      } catch (error) {
        console.error(
          `⚠️ Notification translation fallback (${languageKey}):`,
          error.message
        );
      }
    }

    for (
      const group of
      chunks(
        visible,
        40
      )
    ) {
      const userIds =
        group.map(
          member =>
            member.id
        );

      const mentions =
        userIds
          .map(
            id =>
              `<@${id}>`
          )
          .join(
            " "
          );

      await channel.send({
        content:
          `${mentions}\n${localized}`,

        allowedMentions: {
          parse: [],

          users:
            userIds
        }
      });

      delivered +=
        userIds.length;
    }
  }

  await sendMasterLog(
    roleId,
    label,
    englishText,
    delivered
  );

  return delivered;
}

// =====================================================
// TOURNAMENT STATE + LIVE EVENT BOARD
// =====================================================

async function getActiveTournamentState() {
  const result =
    await pool.query(
      "SELECT * FROM tournament_state WHERE phase <> 'inactive' AND phase <> 'complete' ORDER BY updated_at DESC LIMIT 1"
    );

  return (
    result.rows[0] ||
    null
  );
}

async function setTournamentState(
  tournament,
  activeDate,
  round,
  phase,
  voteEndsAt = null
) {
  await pool.query(
    `INSERT INTO tournament_state(
       tournament,
       active_date,
       round,
       phase,
       vote_ends_at,
       updated_at
     )
     VALUES(
       $1,$2,$3,$4,$5,NOW()
     )
     ON CONFLICT(tournament)
     DO UPDATE SET
       active_date = EXCLUDED.active_date,
       round = EXCLUDED.round,
       phase = EXCLUDED.phase,
       vote_ends_at = EXCLUDED.vote_ends_at,
       updated_at = NOW()`,

    [
      tournament,
      activeDate,
      round,
      phase,
      voteEndsAt
    ]
  );
}

async function startTournamentVote(
  tournamentKey,
  round,
  pingMembers = true
) {
  const tournament =
    TOURNAMENTS[
      tournamentKey
    ];

  const parts =
    chicagoParts();

  const ends =
    new Date(
      Date.now() +
      tournament.voteMinutes *
        60 *
        1000
    );

  await setTournamentState(
    tournamentKey,
    dateKey(
      parts
    ),
    round,
    "voting",
    ends
  );

  if (pingMembers) {
    await sendLocalizedRoleNotification(
      tournament.role,

      `🗳️ ${tournament.name} Round ${round} voting is OPEN! You have ${tournament.voteMinutes} minutes to vote.`,

      `${tournament.name} — Round ${round} Voting Open`
    );
  }

  await updateEventBoard();
}

async function closeTournamentVote(
  state
) {
  const tournament =
    TOURNAMENTS[
      state.tournament
    ];

  const phase =
    state.round >=
    tournament.rounds
      ? "final_battle"
      : "battle";

  await setTournamentState(
    state.tournament,
    state.active_date,
    state.round,
    phase,
    null
  );

  await updateEventBoard();
}

async function finishTournament(
  tournamentKey
) {
  const parts =
    chicagoParts();

  await setTournamentState(
    tournamentKey,
    dateKey(
      parts
    ),
    0,
    "complete",
    null
  );

  await updateEventBoard();
}

function format12Hour(
  hour,
  minute
) {
  const suffix =
    hour >= 12
      ? "PM"
      : "AM";

  const h =
    hour % 12 ||
    12;

  return (
    `${h}:` +
    `${String(
      minute
    ).padStart(
      2,
      "0"
    )} ` +
    suffix
  );
}

function upcomingEvents(
  limit = 5
) {
  const now =
    chicagoParts();

  const nowMinutes =
    now.hour *
      60 +
    now.minute;

  const candidates =
    [];

  for (
    let offset = 0;
    offset <= 14;
    offset++
  ) {
    const calendar =
      new Date(
        Date.UTC(
          now.year,
          now.month - 1,
          now.day + offset,
          12
        )
      );

    const y =
      calendar.getUTCFullYear();

    const m =
      calendar.getUTCMonth() +
      1;

    const d =
      calendar.getUTCDate();

    const weekday =
      calendar.getUTCDay();

    for (
      const event of
      SCHEDULED_EVENTS
    ) {
      if (
        !eventApplies(
          event,
          y,
          m,
          d,
          weekday
        )
      ) {
        continue;
      }

      const [
        hour,
        minute
      ] =
        eventTimeForDate(
          event,
          y,
          m,
          d
        );

      const relativeMinutes =
        offset *
          1440 +
        (
          hour *
            60 +
          minute
        ) -
        nowMinutes;

      if (
        relativeMinutes <
        0
      ) {
        continue;
      }

      candidates.push({
        ...event,
        y,
        m,
        d,
        weekday,
        hour,
        minute,
        relativeMinutes
      });
    }
  }

  return candidates
    .sort(
      (a, b) =>
        a.relativeMinutes -
        b.relativeMinutes
    )
    .slice(
      0,
      limit
    );
}

function eventBoardDefaultEmbed() {
  const events =
    upcomingEvents(
      5
    );

  const lines =
    events.map(
      event => {
        const day =
          event.relativeMinutes <
          1440
            ? "Today"
            : new Intl.DateTimeFormat(
                "en-US",
                {
                  weekday:
                    "short",

                  month:
                    "short",

                  day:
                    "numeric",

                  timeZone:
                    "UTC"
                }
              ).format(
                new Date(
                  Date.UTC(
                    event.y,
                    event.m - 1,
                    event.d,
                    12
                  )
                )
              );

        const hours =
          Math.floor(
            event.relativeMinutes /
            60
          );

        const minutes =
          event.relativeMinutes %
          60;

        const countdown =
          hours
            ? `${hours}h ${minutes}m`
            : `${minutes}m`;

        return (
          `**${event.label}** — ` +
          `${day} at **${format12Hour(
            event.hour,
            event.minute
          )}** • ~${countdown}`
        );
      }
    );

  const now =
    chicagoParts();

  const mode =
    isCentralDSTDate(
      now.year,
      now.month,
      now.day
    )
      ? "Summer / DST schedule"
      : "Winter / Standard schedule";

  return new EmbedBuilder()
    .setTitle(
      "🖤 Ashen Live Event Board"
    )
    .setDescription(
      lines.join(
        "\n"
      ) ||
      "No upcoming events found."
    )
    .addFields({
      name:
        "🕒 Current Game Schedule",

      value:
        mode
    })
    .setFooter({
      text:
        "Vestra updates this board automatically."
    })
    .setTimestamp();
}
async function eventBoardPayload() {
  const state =
    await getActiveTournamentState();

  const rows = [
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            "settings_open"
          )
          .setLabel(
            "My Settings"
          )
          .setEmoji(
            "✨"
          )
          .setStyle(
            ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            "settings_card"
          )
          .setLabel(
            "My Vestra Card"
          )
          .setEmoji(
            "👤"
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      )
  ];

  if (!state) {
    return {
      embeds: [
        eventBoardDefaultEmbed()
      ],

      components:
        rows
    };
  }

  const tournament =
    TOURNAMENTS[
      state.tournament
    ];

  const embed =
    new EmbedBuilder()
      .setTitle(
        `${tournament.emoji} ${tournament.name} — Round ${state.round}/${tournament.rounds}`
      )
      .setFooter({
        text:
          "Vestra Tournament Mode"
      })
      .setTimestamp();

  if (
    state.phase ===
    "voting"
  ) {
    const unix =
      Math.floor(
        new Date(
          state.vote_ends_at
        ).getTime() /
        1000
      );

    embed
      .setDescription(
        "## 🟢 VOTING OPEN\nVote now!"
      )
      .addFields(
        {
          name:
            "⏳ Voting closes",

          value:
            `<t:${unix}:R> • <t:${unix}:t>`
        },

        {
          name:
            "Next",

          value:
            "⚔️ Battle begins when voting closes."
        }
      );

  } else if (
    state.phase ===
    "battle"
  ) {
    embed
      .setDescription(
        "## 🔴 BATTLE IN PROGRESS\nVoting is closed."
      )
      .addFields({
        name:
          "Next",

        value:
          `Staff will open Round ${state.round + 1} voting when the battle ends.`
      });

    rows.push(
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(
              "tournament_next"
            )
            .setLabel(
              "Start Next Vote"
            )
            .setEmoji(
              "🗳️"
            )
            .setStyle(
              ButtonStyle.Success
            )
        )
    );

  } else if (
    state.phase ===
    "final_battle"
  ) {
    embed
      .setDescription(
        "## 🔴 FINAL BATTLE IN PROGRESS\nRound 4 voting is closed."
      )
      .addFields({
        name:
          "Next",

        value:
          "Staff can finish Tournament Mode when the final battle ends."
      });

    rows.push(
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(
              "tournament_finish"
            )
            .setLabel(
              "Finish Tournament"
            )
            .setEmoji(
              "🏁"
            )
            .setStyle(
              ButtonStyle.Primary
            )
        )
    );
  }

  return {
    embeds: [
      embed
    ],

    components:
      rows
  };
}

async function setupEventBoard() {
  const channel =
    await client.channels.fetch(
      CHANNELS.EVENT_BOARD
    );

  if (
    !channel?.isTextBased()
  ) {
    return;
  }

  let state =
    await dbGetState(
      "event_board_message"
    );

  let message =
    state?.messageId
      ? await channel.messages.fetch(
          state.messageId
        ).catch(
          () => null
        )
      : null;

  if (!message) {
    const recent =
      await channel.messages.fetch({
        limit: 50
      });

    message =
      recent.find(
        m =>
          m.author.id ===
            client.user.id &&
          m.embeds?.[0]
            ?.title
            ?.includes(
              "Ashen Live Event Board"
            )
      ) || null;
  }

  const payload =
    await eventBoardPayload();

  if (!message) {
    message =
      await channel.send(
        payload
      );

  } else {
    await message.edit(
      payload
    );
  }

  await dbSetState(
    "event_board_message",
    {
      messageId:
        message.id
    }
  );

  console.log(
    "✅ Live Ashen Event Board ready."
  );
}

async function updateEventBoard() {
  const channel =
    await client.channels.fetch(
      CHANNELS.EVENT_BOARD
    ).catch(
      () => null
    );

  if (
    !channel?.isTextBased()
  ) {
    return;
  }

  const state =
    await dbGetState(
      "event_board_message"
    );

  let message =
    state?.messageId
      ? await channel.messages.fetch(
          state.messageId
        ).catch(
          () => null
        )
      : null;

  if (!message) {
    return setupEventBoard();
  }

  await message.edit(
    await eventBoardPayload()
  ).catch(
    error =>
      console.error(
        "❌ Event Board update:",
        error.message
      )
  );
}

// =====================================================
// SCHEDULER
// =====================================================

let schedulerRunning =
  false;

async function wasEventSent(
  key
) {
  const result =
    await pool.query(
      "SELECT 1 FROM sent_events WHERE event_key = $1",
      [
        key
      ]
    );

  return !!result.rows[0];
}

async function markEventSent(
  key
) {
  await pool.query(
    "INSERT INTO sent_events(event_key) VALUES($1) ON CONFLICT(event_key) DO NOTHING",
    [
      key
    ]
  );
}

async function processScheduledEvent(
  event,
  parts
) {
  const persistentKey =
    `${dateKey(
      parts
    )}:${event.key}`;

  if (
    await wasEventSent(
      persistentKey
    )
  ) {
    return;
  }

  if (
    event.kind ===
    "start"
  ) {
    await startTournamentVote(
      event.tournament,
      1,
      true
    );

  } else {
    await sendLocalizedRoleNotification(
      event.role,
      event.text,
      event.label
    );
  }

  await markEventSent(
    persistentKey
  );
}

async function checkSchedule() {
  if (
    schedulerRunning
  ) {
    return;
  }

  schedulerRunning =
    true;

  try {
    const now =
      chicagoParts();

    const currentMinutes =
      now.hour *
        60 +
      now.minute;

    for (
      const event of
      SCHEDULED_EVENTS
    ) {
      if (
        !eventApplies(
          event,
          now.year,
          now.month,
          now.day,
          now.weekday
        )
      ) {
        continue;
      }

      const [
        hour,
        minute
      ] =
        eventTimeForDate(
          event,
          now.year,
          now.month,
          now.day
        );

      const late =
        currentMinutes -
        (
          hour *
            60 +
          minute
        );

      if (
        late < 0 ||
        late > 3
      ) {
        continue;
      }

      try {
        await processScheduledEvent(
          event,
          now
        );

      } catch (error) {
        console.error(
          `❌ Scheduled event error (${event.key}):`,
          error
        );
      }
    }

    const active =
      await getActiveTournamentState();

    if (
      active?.phase ===
        "voting" &&
      active.vote_ends_at &&
      new Date(
        active.vote_ends_at
      ).getTime() <=
        Date.now()
    ) {
      await closeTournamentVote(
        active
      );
    }

  } finally {
    schedulerRunning =
      false;
  }
}

function startScheduler() {
  console.log(
    "✅ Persistent DST-aware scheduler active."
  );

  void checkSchedule();

  setInterval(
    () =>
      void checkSchedule(),
    20_000
  );

  setInterval(
    () =>
      void updateEventBoard(),
    60_000
  );
}

// =====================================================
// PERMISSION CHECKS
// =====================================================

async function checkChannelPermissions(
  channelId,
  label,
  required
) {
  const channel =
    await client.channels.fetch(
      channelId
    ).catch(
      () => null
    );

  if (!channel) {
    console.error(
      `❌ ${label}: Channel unavailable`
    );

    return;
  }

  const guild =
    channel.guild;

  const me =
    guild.members.me ||
    await guild.members.fetchMe();

  const permissions =
    channel.permissionsFor(
      me
    );

  const missing =
    required
      .filter(
        permission =>
          !permissions?.has(
            permission.flag
          )
      )
      .map(
        permission =>
          permission.name
      );

  if (
    missing.length
  ) {
    console.error(
      `❌ ${label}: Missing ${missing.join(", ")}`
    );

  } else {
    console.log(
      `✅ ${label}: Permissions OK`
    );
  }
}

async function runPermissionChecks() {
  const basic = [
    {
      name:
        "View Channel",

      flag:
        PermissionFlagsBits.ViewChannel
    },

    {
      name:
        "Send Messages",

      flag:
        PermissionFlagsBits.SendMessages
    },

    {
      name:
        "Read Message History",

      flag:
        PermissionFlagsBits.ReadMessageHistory
    }
  ];

  const webhook = [
    ...basic,

    {
      name:
        "Manage Webhooks",

      flag:
        PermissionFlagsBits.ManageWebhooks
    }
  ];

  await checkChannelPermissions(
    CHANNELS.REMINDERS,
    "#guild-pings",
    basic
  );

  await checkChannelPermissions(
    CHANNELS.PREFERENCES,
    "#preferences",
    [
      ...basic,

      {
        name:
          "Add Reactions",

        flag:
          PermissionFlagsBits.AddReactions
      }
    ]
  );

  await checkChannelPermissions(
    CHANNELS.HELP,
    "#help",
    basic
  );

  await checkChannelPermissions(
    CHANNELS.EVENT_BOARD,
    "Live Event Board",
    basic
  );

  await checkChannelPermissions(
    CHANNELS.HIGHLIGHTS,
    "Community Highlights",
    basic
  );

  for (
    const info of
    Object.values(
      LANGUAGE_CHANNELS
    )
  ) {
    await checkChannelPermissions(
      info.channel,
      `${info.name} General`,
      webhook
    );
  }

  const guild =
    getGuild();

  if (guild) {
    const socialChannels =
      guild.channels.cache.filter(
        channel =>
          channel.parentId ===
            SOCIAL_CATEGORY_ID &&
          channel.isTextBased()
      );

    for (
      const channel of
      socialChannels.values()
    ) {
      await checkChannelPermissions(
        channel.id,
        `Social #${channel.name}`,
        basic
      );
    }

    const me =
      guild.members.me ||
      await guild.members.fetchMe();

    if (
      !me.permissions.has(
        PermissionFlagsBits.ManageRoles
      )
    ) {
      console.error(
        "❌ Server: Vestra is missing Manage Roles"
      );

    } else {
      console.log(
        "✅ Server: Manage Roles OK"
      );

      const managedRoleIds =
        new Set([
          ASHEN_WARRIORS,
          ONBOARDING_COMPLETE,

          ...Object.values(
            LANGUAGES
          ).map(
            x => x.role
          ),

          ...Object.values(
            PLAYSTYLE
          ).map(
            x => x.role
          ),

          ...Object.values(
            SOCIAL
          ).map(
            x => x.role
          ),

          ...Object.values(
            REMINDERS
          ).map(
            x => x.role
          ),

          ...Object.values(
            TOURNAMENTS
          ).map(
            x => x.role
          )
        ]);

      const tooHigh =
        guild.roles.cache
          .filter(
            role =>
              managedRoleIds.has(
                role.id
              ) &&
              role.position >=
                me.roles.highest.position
          )
          .map(
            role =>
              role.name
          );

      if (
        tooHigh.length
      ) {
        console.error(
          `❌ Role hierarchy: move Vestra above ${tooHigh.join(", ")}`
        );

      } else {
        console.log(
          "✅ Role hierarchy: Vestra can manage all community roles"
        );
      }
    }
  }

  console.log(
    "✅ Startup permission audit finished."
  );
}

// =====================================================
// MEMBER JOIN + REACTION ROLES
// =====================================================

client.on(
  Events.GuildMemberAdd,

  async member => {
    if (
      member.user.bot
    ) {
      return;
    }

    try {
      await member.roles.add(
        ASHEN_WARRIORS
      );

      console.log(
        `✅ Ashen Warriors added to ${member.user.tag}`
      );

    } catch (error) {
      console.error(
        "❌ Could not add Ashen Warriors:",
        error.message
      );
    }
  }
);

function itemByEmoji(
  group,
  emoji
) {
  return Object.values(
    group
  ).find(
    x =>
      x.emoji ===
      emoji
  );
}

async function reactionRole(
  reaction,
  user,
  adding
) {
  if (
    user.bot
  ) {
    return;
  }

  if (
    reaction.partial
  ) {
    await reaction.fetch();
  }

  const message =
    reaction.message;

  if (
    !message.guild
  ) {
    return;
  }

  const member =
    await message.guild.members.fetch(
      user.id
    );

  const emoji =
    reaction.emoji.name;

  if (
    message.id ===
    preferenceMessages.languages
      ?.id
  ) {
    const item =
      itemByEmoji(
        LANGUAGES,
        emoji
      );

    if (!item) {
      return;
    }

    if (adding) {
      await member.roles.add(
        item.role
      );

      const existing =
        await pool.query(
          "SELECT primary_language FROM user_preferences WHERE user_id = $1",
          [
            member.id
          ]
        );

      if (
        !existing.rows[0]
          ?.primary_language
      ) {
        const key =
          Object.entries(
            LANGUAGES
          ).find(
            ([, value]) =>
              value.role ===
              item.role
          )?.[0];

        if (key) {
          await savePrimaryLanguage(
            member.id,
            key
          );
        }
      }

    } else {
      await member.roles.remove(
        item.role
      );

      const current =
        await inferPrimaryLanguage(
          member
        );

      if (
        LANGUAGE_CHANNELS[
          current
        ].role ===
        item.role
      ) {
        const fallback =
          LANGUAGE_KEYS.find(
            key =>
              key !== current &&
              member.roles.cache.has(
                LANGUAGE_CHANNELS[
                  key
                ].role
              )
          );

        if (fallback) {
          await savePrimaryLanguage(
            member.id,
            fallback
          );
        }
      }
    }

    return;
  }

  if (
    message.id ===
    preferenceMessages.reminders
      ?.id
  ) {
    const item =
      itemByEmoji(
        REMINDERS,
        emoji
      );

    if (!item) {
      return;
    }

    if (adding) {
      await member.roles.add(
        item.role
      );

    } else {
      await member.roles.remove(
        item.role
      );
    }

    return;
  }

  if (
    message.id ===
    preferenceMessages.playstyle
      ?.id
  ) {
    const item =
      itemByEmoji(
        PLAYSTYLE,
        emoji
      );

    if (!item) {
      return;
    }

    if (adding) {
      for (
        const other of
        Object.values(
          PLAYSTYLE
        )
      ) {
        if (
          other.role !==
            item.role &&
          member.roles.cache.has(
            other.role
          )
        ) {
          await member.roles.remove(
            other.role
          );
        }
      }

      await member.roles.add(
        item.role
      );

    } else {
      await member.roles.remove(
        item.role
      );
    }

    return;
  }

  if (
    message.id ===
    preferenceMessages.social
      ?.id
  ) {
    const item =
      itemByEmoji(
        SOCIAL,
        emoji
      );

    if (!item) {
      return;
    }

    if (adding) {
      for (
        const other of
        Object.values(
          SOCIAL
        )
      ) {
        if (
          other.role !==
            item.role &&
          member.roles.cache.has(
            other.role
          )
        ) {
          await member.roles.remove(
            other.role
          );
        }
      }

      await member.roles.add(
        item.role
      );

    } else {
      await member.roles.remove(
        item.role
      );
    }
  }
}
// =====================================================
// MESSAGE EVENTS
// =====================================================

client.on(
  Events.MessageCreate,

  async message => {
    try {
      if (
        !message.guild ||
        message.author.bot ||
        message.webhookId
      ) {
        return;
      }

      if (
        languageByChannel(
          message.channel.id
        )
      ) {
        await handleGeneralMessageCreate(
          message
        );

        return;
      }

      if (
        isSocialChannel(
          message.channel
        )
      ) {
        await createSocialCompanion(
          message
        );
      }

    } catch (error) {
      console.error(
        "❌ MessageCreate handler:",
        error
      );
    }
  }
);

client.on(
  Events.MessageUpdate,

  async (
    oldMessage,
    newMessage
  ) => {
    try {
      if (
        newMessage.partial
      ) {
        newMessage =
          await newMessage.fetch();
      }

      if (
        !newMessage.guild ||
        newMessage.author?.bot ||
        newMessage.webhookId
      ) {
        return;
      }

      if (
        languageByChannel(
          newMessage.channel.id
        )
      ) {
        await handleGeneralMessageUpdate(
          newMessage
        );
      }

    } catch (error) {
      console.error(
        "❌ MessageUpdate handler:",
        error
      );
    }
  }
);

client.on(
  Events.MessageDelete,

  async message => {
    try {
      const mapping =
        await getGroupByMessageId(
          message.id
        ).catch(
          () => null
        );

      if (
        mapping?.is_source
      ) {
        await deleteTranslatedGroup(
          mapping.group_id
        );

        await removeHighlight(
          message.id
        );

        console.log(
          `🗑️ Deleted translated copies for ${message.id}`
        );

        return;
      }

      if (
        mapping &&
        !mapping.is_source
      ) {
        await pool.query(
          "DELETE FROM translation_messages WHERE message_id = $1",
          [
            message.id
          ]
        );

        await pool.query(
          "DELETE FROM message_reactions WHERE message_id = $1",
          [
            message.id
          ]
        );

        return;
      }

      await deleteSocialCompanion(
        message.id
      );

      await removeHighlight(
        message.id
      );

      const companionResult =
        await pool.query(
          "SELECT original_message_id FROM social_companions WHERE companion_message_id = $1",
          [
            message.id
          ]
        );

      if (
        companionResult.rows[0]
      ) {
        await pool.query(
          "DELETE FROM social_companions WHERE companion_message_id = $1",
          [
            message.id
          ]
        );
      }

    } catch (error) {
      console.error(
        "❌ MessageDelete handler:",
        error
      );
    }
  }
);

// =====================================================
// REACTION SYNC + HIGHLIGHTS
// =====================================================

async function handleReactionChange(
  reaction,
  user,
  adding
) {
  if (
    user.bot
  ) {
    return;
  }

  if (
    reaction.partial
  ) {
    await reaction.fetch();
  }

  if (
    reaction.message.partial
  ) {
    await reaction.message.fetch();
  }

  await reactionRole(
    reaction,
    user,
    adding
  ).catch(
    () => {}
  );

  const mapping =
    await getGroupByMessageId(
      reaction.message.id
    ).catch(
      () => null
    );

  if (mapping) {
    const key =
      emojiKey(
        reaction.emoji
      );

    if (adding) {
      await pool.query(
        `INSERT INTO message_reactions(
           message_id,
           group_id,
           user_id,
           emoji_key
         )
         VALUES($1,$2,$3,$4)
         ON CONFLICT
         DO NOTHING`,

        [
          reaction.message.id,
          mapping.group_id,
          user.id,
          key
        ]
      );

    } else {
      await pool.query(
        "DELETE FROM message_reactions WHERE message_id = $1 AND group_id = $2 AND user_id = $3 AND emoji_key = $4",
        [
          reaction.message.id,
          mapping.group_id,
          user.id,
          key
        ]
      );
    }

    await updateReactionSummaries(
      mapping.group_id
    );

    if (adding) {
      await maybeHighlightGroup(
        mapping.group_id
      );
    }

    return;
  }

  if (adding) {
    await maybeHighlightNative(
      reaction.message
    );
  }
}

client.on(
  Events.MessageReactionAdd,

  (
    reaction,
    user
  ) => {
    void handleReactionChange(
      reaction,
      user,
      true
    ).catch(
      error =>
        console.error(
          "❌ Reaction add:",
          error
        )
    );
  }
);

client.on(
  Events.MessageReactionRemove,

  (
    reaction,
    user
  ) => {
    void handleReactionChange(
      reaction,
      user,
      false
    ).catch(
      error =>
        console.error(
          "❌ Reaction remove:",
          error
        )
    );
  }
);

// =====================================================
// INTERACTIONS
// =====================================================

client.on(
  Events.InteractionCreate,

  async interaction => {
    try {

      if (
        interaction.isButton() &&
        interaction.customId ===
          "help_game"
      ) {
        return interaction.showModal(
          createHelpModal(
            "modal_game_help",
            "Game Help",
            "What do you need help with?",
            "Explain what you're stuck on..."
          )
        );
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "help_team"
      ) {
        return interaction.showModal(
          createHelpModal(
            "modal_team_help",
            "Find a Team",
            "What are you looking for?",
            "Tell everyone what you need teammates for..."
          )
        );
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "help_staff"
      ) {
        return interaction.showModal(
          createHelpModal(
            "modal_staff_help",
            "Contact Ashen Staff",
            "What would you like staff to know?",
            "Explain your request or concern..."
          )
        );
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "help_discord"
      ) {
        return interaction.showModal(
          createHelpModal(
            "modal_discord_help",
            "Discord Help",
            "What do you need help with?",
            "Explain the Discord or server issue..."
          )
        );
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "help_faq"
      ) {
        return interaction.reply({
          content:
            "# ❓ Ashen FAQ\n\n" +

            `🌎 **Languages / notification language:** <#${CHANNELS.PREFERENCES}>\n` +

            `🔔 **Reminder pings:** <#${CHANNELS.PREFERENCES}>\n` +

            "🌐 **Social translation:** tap Vestra's Translate button below a Social message.\n" +

            "🛡️ **Private staff help:** use Ask Staff in this Help Center.",

          flags:
            MessageFlags.Ephemeral
        });
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "help_guide"
      ) {
        return interaction.reply({
          content:
            "# 🧭 Ashen Server Guide\n\n" +

            `📍 <#${CHANNELS.START_HERE}> — Start here\n` +

            `📜 <#${CHANNELS.RULES}> — Rules\n` +

            `🌎 <#${CHANNELS.ONBOARDING}> — Onboarding\n` +

            `✨ <#${CHANNELS.PREFERENCES}> — Vestra settings\n` +

            `👋 <#${CHANNELS.INTRODUCTIONS}> — Introductions\n` +

            `🆘 <#${CHANNELS.HELP}> — Help Center`,

          flags:
            MessageFlags.Ephemeral
        });
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId ===
          "modal_game_help"
      ) {
        return createHelpThread(
          interaction,
          "Game Help",
          "🎮",
          interaction.fields
            .getTextInputValue(
              "help_details"
            )
        );
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId ===
          "modal_team_help"
      ) {
        return createHelpThread(
          interaction,
          "Looking for a Team",
          "👥",
          interaction.fields
            .getTextInputValue(
              "help_details"
            )
        );
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId ===
          "modal_discord_help"
      ) {
        return createHelpThread(
          interaction,
          "Discord Help",
          "⚙️",
          interaction.fields
            .getTextInputValue(
              "help_details"
            )
        );
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId ===
          "modal_staff_help"
      ) {
        const details =
          interaction.fields
            .getTextInputValue(
              "help_details"
            );

        const staffChannel =
          await interaction.guild.channels.fetch(
            CHANNELS.STAFF_REQUESTS
          );

        if (
          !staffChannel?.isTextBased()
        ) {
          return interaction.reply({
            content:
              "❌ Vestra couldn't reach the staff request channel.",

            flags:
              MessageFlags.Ephemeral
          });
        }

        await staffChannel.send({
          content:
            "# 🛡️ New Staff Request\n\n" +

            `<@&${STAFF_ROLES.LEADER}> ` +
            `<@&${STAFF_ROLES.DEPUTY}> ` +
            `<@&${STAFF_ROLES.OFFICERS}>\n\n` +

            `**Member:** ${interaction.member}\n` +
            `**User:** ${interaction.user.username}\n\n` +

            `**Request:**\n${details}`,

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
          content:
            "✅ Your message was sent privately to Ashen staff.",

          flags:
            MessageFlags.Ephemeral
        });
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "start_onboarding"
      ) {
        sessions.set(
          interaction.user.id,
          {
            language: null,
            reminders: [],
            playstyle: null,
            social: null
          }
        );

        return interaction.reply({
          content:
            "# 🌎 Choose your primary language\n\n" +
            "This also becomes your default Vestra notification language.",

          components: [
            languageMenu()
          ],

          flags:
            MessageFlags.Ephemeral
        });
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId ===
          "onboard_language"
      ) {
        const language =
          interaction.values[0];

        const session =
          sessions.get(
            interaction.user.id
          ) || {};

        Object.assign(
          session,
          {
            language,
            reminders: [],
            playstyle: null,
            social: null
          }
        );

        sessions.set(
          interaction.user.id,
          session
        );

        return interaction.update({
          content:
            `# ${TEXT[language].welcome}\n\n` +
            `## 🔔 ${TEXT[language].reminders}`,

          components: [
            reminderMenu(
              language
            )
          ]
        });
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId ===
          "onboard_reminders"
      ) {
        const session =
          sessions.get(
            interaction.user.id
          );

        if (!session) {
          return;
        }

        session.reminders =
          interaction.values.includes(
            "none"
          )
            ? []
            : interaction.values.filter(
                x =>
                  x !==
                  "none"
              );

        return interaction.update({
          content:
            `# 🎮 ${TEXT[session.language].playstyle}`,

          components: [
            playstyleMenu(
              session.language
            )
          ]
        });
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId ===
          "onboard_playstyle"
      ) {
        const session =
          sessions.get(
            interaction.user.id
          );

        if (!session) {
          return;
        }

        session.playstyle =
          interaction.values[0] ===
          "skip"
            ? null
            : interaction.values[0];

        return interaction.update({
          content:
            `# 💬 ${TEXT[session.language].social}`,

          components: [
            socialMenu(
              session.language
            )
          ]
        });
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId ===
          "onboard_social"
      ) {
        const session =
          sessions.get(
            interaction.user.id
          );

        if (!session) {
          return;
        }

        session.social =
          interaction.values[0] ===
          "skip"
            ? null
            : interaction.values[0];

        return interaction.update({
          content:
            "✅ Ready to finish!",

          components: [
            finishButton(
              session.language
            )
          ]
        });
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "onboard_finish"
      ) {
        await interaction.deferUpdate();

        const session =
          sessions.get(
            interaction.user.id
          );

        if (!session) {
          return interaction.editReply({
            content:
              "Your onboarding session expired. Please start again.",

            components:
              []
          });
        }

        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        for (
          const roleId of
          RESETTABLE_ROLES
        ) {
          if (
            PROTECTED_ROLES.has(
              roleId
            )
          ) {
            continue;
          }

          if (
            member.roles.cache.has(
              roleId
            )
          ) {
            await member.roles.remove(
              roleId
            ).catch(
              () => {}
            );
          }
        }

        await member.roles.add(
          ASHEN_WARRIORS
        );

        await member.roles.add(
          LANGUAGES[
            session.language
          ].role
        );

        for (
          const key of
          session.reminders
        ) {
          if (
            REMINDERS[
              key
            ]
          ) {
            await member.roles.add(
              REMINDERS[
                key
              ].role
            );
          }
        }

        if (
          session.playstyle
        ) {
          await member.roles.add(
            PLAYSTYLE[
              session.playstyle
            ].role
          );
        }

        if (
          session.social
        ) {
          await member.roles.add(
            SOCIAL[
              session.social
            ].role
          );
        }

        await member.roles.add(
          ONBOARDING_COMPLETE
        );

        await savePrimaryLanguage(
          member.id,
          session.language
        );

        const intro =
          await interaction.guild.channels.fetch(
            CHANNELS.INTRODUCTIONS
          ).catch(
            () => null
          );

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

        sessions.delete(
          interaction.user.id
        );

        return interaction.editReply({
          content:
            `# ✅ ${TEXT[session.language].done}`,

          components:
            []
        });
      }

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          "social_translate:"
        )
      ) {
        await interaction.deferReply({
          flags:
            MessageFlags.Ephemeral
        });

        const originalId =
          interaction.customId.split(
            ":"
          )[1];

        const channel =
          interaction.channel;

        const original =
          await channel.messages.fetch(
            originalId
          ).catch(
            () => null
          );

        if (!original) {
          return interaction.editReply(
            "❌ That original message no longer exists."
          );
        }

        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        const targetKey =
          await inferPrimaryLanguage(
            member
          );

        const target =
          LANGUAGE_CHANNELS[
            targetKey
          ];

        let translated;

        try {
          translated =
            await googleTranslate(
              original.content,
              target.code,
              null
            );

        } catch (error) {
          console.error(
            "❌ Social translation:",
            error.message
          );

          return interaction.editReply(
            "❌ Translation is temporarily unavailable. Try again in a moment."
          );
        }

        const embed =
          new EmbedBuilder()
            .setTitle(
              `${target.emoji} Translation → ${target.name}`
            )
            .setDescription(
              limitText(
                translated,
                3900
              )
            )
            .setAuthor({
              name:
                safeDisplayName(
                  original.member,
                  original.author
                ),

              iconURL:
                original.author.displayAvatarURL({
                  size: 128
                })
            })
            .setFooter({
              text:
                "Only you can see this • Vestra"
            });

        return interaction.editReply({
          embeds: [
            embed
          ]
        });
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "settings_open"
      ) {
        const payload = {
          embeds: [
            settingsHomeEmbed()
          ],

          components:
            settingsHomeComponents()
        };

        if (
          interaction.message
            ?.flags
            ?.has
            ?.(MessageFlags.Ephemeral)
        ) {
          return interaction.update(
            payload
          );
        }

        return interaction.reply({
          ...payload,

          flags:
            MessageFlags.Ephemeral
        });
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "settings_back"
      ) {
        return interaction.update({
          embeds: [
            settingsHomeEmbed()
          ],

          components:
            settingsHomeComponents()
        });
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "settings_card"
      ) {
        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        const embed =
          await memberCardEmbed(
            member
          );

        if (
          interaction.message
            ?.flags
            ?.has
            ?.(MessageFlags.Ephemeral)
        ) {
          return interaction.update({
            embeds: [
              embed
            ],

            components: [
              backButtonRow()
            ]
          });
        }

        return interaction.reply({
          embeds: [
            embed
          ],

          components: [
            backButtonRow()
          ],

          flags:
            MessageFlags.Ephemeral
        });
      }
            if (
        interaction.isButton() &&
        interaction.customId ===
          "settings_languages"
      ) {
        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        const selected =
          LANGUAGE_KEYS.filter(
            key =>
              member.roles.cache.has(
                LANGUAGE_CHANNELS[
                  key
                ].role
              )
          );

        const menu =
          new StringSelectMenuBuilder()
            .setCustomId(
              "settings_languages_select"
            )
            .setPlaceholder(
              "Choose every language channel you want"
            )
            .setMinValues(
              1
            )
            .setMaxValues(
              LANGUAGE_KEYS.length
            )
            .addOptions(
              LANGUAGE_KEYS.map(
                key => ({
                  label:
                    LANGUAGE_CHANNELS[
                      key
                    ].name,

                  value:
                    key,

                  emoji:
                    LANGUAGE_CHANNELS[
                      key
                    ].emoji,

                  default:
                    selected.includes(
                      key
                    )
                })
              )
            );

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                "🌎 Language Access"
              )
              .setDescription(
                "Choose every General language channel you want to see."
              )
          ],

          components: [
            new ActionRowBuilder()
              .addComponents(
                menu
              ),

            backButtonRow()
          ]
        });
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId ===
          "settings_languages_select"
      ) {
        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        const selected =
          new Set(
            interaction.values
          );

        for (
          const key of
          LANGUAGE_KEYS
        ) {
          const role =
            LANGUAGE_CHANNELS[
              key
            ].role;

          if (
            selected.has(
              key
            ) &&
            !member.roles.cache.has(
              role
            )
          ) {
            await member.roles.add(
              role
            ).catch(
              () => {}
            );
          }

          if (
            !selected.has(
              key
            ) &&
            member.roles.cache.has(
              role
            )
          ) {
            await member.roles.remove(
              role
            ).catch(
              () => {}
            );
          }
        }

        const primary =
          await inferPrimaryLanguage(
            member
          );

        if (
          !selected.has(
            primary
          )
        ) {
          await savePrimaryLanguage(
            member.id,
            interaction.values[0]
          );
        }

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                "✅ Language Access Updated"
              )
              .setDescription(
                "Your language channel access has been saved."
              )
          ],

          components: [
            backButtonRow()
          ]
        });
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "settings_notify"
      ) {
        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        const current =
          await inferPrimaryLanguage(
            member
          );

        const menu =
          new StringSelectMenuBuilder()
            .setCustomId(
              "settings_notify_select"
            )
            .setPlaceholder(
              "Choose one notification language"
            )
            .addOptions(
              LANGUAGE_KEYS.map(
                key => ({
                  label:
                    LANGUAGE_CHANNELS[
                      key
                    ].name,

                  value:
                    key,

                  emoji:
                    LANGUAGE_CHANNELS[
                      key
                    ].emoji,

                  default:
                    current === key
                })
              )
            );

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                "🔔 Primary Notification Language"
              )
              .setDescription(
                "Vestra sends your event pings **once**, in this language's General channel."
              )
          ],

          components: [
            new ActionRowBuilder()
              .addComponents(
                menu
              ),

            backButtonRow()
          ]
        });
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId ===
          "settings_notify_select"
      ) {
        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        const key =
          interaction.values[0];

        if (
          !member.roles.cache.has(
            LANGUAGE_CHANNELS[
              key
            ].role
          )
        ) {
          await member.roles.add(
            LANGUAGE_CHANNELS[
              key
            ].role
          );
        }

        await savePrimaryLanguage(
          member.id,
          key
        );

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                "✅ Notification Language Updated"
              )
              .setDescription(
                `${LANGUAGE_CHANNELS[key].emoji} Vestra will notify you in **${LANGUAGE_CHANNELS[key].name}**.`
              )
          ],

          components: [
            backButtonRow()
          ]
        });
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "settings_reminders"
      ) {
        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        const selected =
          Object.entries(
            REMINDERS
          )
            .filter(
              ([, item]) =>
                member.roles.cache.has(
                  item.role
                )
            )
            .map(
              ([key]) =>
                key
            );

        const menu =
          new StringSelectMenuBuilder()
            .setCustomId(
              "settings_reminders_select"
            )
            .setPlaceholder(
              "Choose game alerts"
            )
            .setMinValues(
              1
            )
            .setMaxValues(
              8
            )
            .addOptions(
              ...Object.entries(
                REMINDERS
              ).map(
                ([key, item]) => ({
                  label:
                    item.name,

                  value:
                    key,

                  emoji:
                    item.emoji,

                  default:
                    selected.includes(
                      key
                    )
                })
              ),

              {
                label:
                  "No game pings",

                value:
                  "none",

                emoji:
                  "🔕",

                default:
                  selected.length ===
                  0
              }
            );

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                "⏰ Game Reminder Pings"
              )
              .setDescription(
                "Choose the events you want Vestra to notify you about."
              )
          ],

          components: [
            new ActionRowBuilder()
              .addComponents(
                menu
              ),

            backButtonRow()
          ]
        });
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId ===
          "settings_reminders_select"
      ) {
        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        const selected =
          interaction.values.includes(
            "none"
          )
            ? new Set()
            : new Set(
                interaction.values
              );

        for (
          const [
            key,
            item
          ] of Object.entries(
            REMINDERS
          )
        ) {
          if (
            selected.has(
              key
            ) &&
            !member.roles.cache.has(
              item.role
            )
          ) {
            await member.roles.add(
              item.role
            ).catch(
              () => {}
            );
          }

          if (
            !selected.has(
              key
            ) &&
            member.roles.cache.has(
              item.role
            )
          ) {
            await member.roles.remove(
              item.role
            ).catch(
              () => {}
            );
          }
        }

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                "✅ Game Pings Updated"
              )
          ],

          components: [
            backButtonRow()
          ]
        });
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "settings_tournaments"
      ) {
        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        const selected =
          Object.entries(
            TOURNAMENTS
          )
            .filter(
              ([, item]) =>
                member.roles.cache.has(
                  item.role
                )
            )
            .map(
              ([key]) =>
                key
            );

        const menu =
          new StringSelectMenuBuilder()
            .setCustomId(
              "settings_tournaments_select"
            )
            .setPlaceholder(
              "Choose tournament vote alerts"
            )
            .setMinValues(
              1
            )
            .setMaxValues(
              3
            )
            .addOptions(
              {
                label:
                  "Sever Tournament",

                value:
                  "sever",

                emoji:
                  "⚔️",

                default:
                  selected.includes(
                    "sever"
                  )
              },

              {
                label:
                  "Nexus Tournament",

                value:
                  "nexus",

                emoji:
                  "🌀",

                default:
                  selected.includes(
                    "nexus"
                  )
              },

              {
                label:
                  "No tournament pings",

                value:
                  "none",

                emoji:
                  "🔕",

                default:
                  selected.length ===
                  0
              }
            );

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                "🏆 Tournament Vote Pings"
              )
              .setDescription(
                "Opt in to Sever, Nexus, both, or neither."
              )
          ],

          components: [
            new ActionRowBuilder()
              .addComponents(
                menu
              ),

            backButtonRow()
          ]
        });
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId ===
          "settings_tournaments_select"
      ) {
        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        const selected =
          interaction.values.includes(
            "none"
          )
            ? new Set()
            : new Set(
                interaction.values
              );

        for (
          const [
            key,
            item
          ] of Object.entries(
            TOURNAMENTS
          )
        ) {
          if (
            selected.has(
              key
            ) &&
            !member.roles.cache.has(
              item.role
            )
          ) {
            await member.roles.add(
              item.role
            ).catch(
              () => {}
            );
          }

          if (
            !selected.has(
              key
            ) &&
            member.roles.cache.has(
              item.role
            )
          ) {
            await member.roles.remove(
              item.role
            ).catch(
              () => {}
            );
          }
        }

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                "✅ Tournament Pings Updated"
              )
          ],

          components: [
            backButtonRow()
          ]
        });
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "settings_playstyle"
      ) {
        const menu =
          new StringSelectMenuBuilder()
            .setCustomId(
              "settings_playstyle_select"
            )
            .setPlaceholder(
              "Choose your playstyle"
            )
            .addOptions(
              ...Object.entries(
                PLAYSTYLE
              ).map(
                ([key, item]) => ({
                  label:
                    item.name,

                  value:
                    key,

                  emoji:
                    item.emoji
                })
              ),

              {
                label:
                  "None",

                value:
                  "none",

                emoji:
                  "⏭️"
              }
            );

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                "🎮 Playstyle"
              )
          ],

          components: [
            new ActionRowBuilder()
              .addComponents(
                menu
              ),

            backButtonRow()
          ]
        });
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId ===
          "settings_playstyle_select"
      ) {
        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        const selected =
          interaction.values[0] ===
          "none"
            ? null
            : interaction.values[0];

        await updateSingleChoiceRole(
          member,
          PLAYSTYLE,
          selected
        );

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                "✅ Playstyle Updated"
              )
          ],

          components: [
            backButtonRow()
          ]
        });
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "settings_social"
      ) {
        const menu =
          new StringSelectMenuBuilder()
            .setCustomId(
              "settings_social_select"
            )
            .setPlaceholder(
              "Choose your social preference"
            )
            .addOptions(
              ...Object.entries(
                SOCIAL
              ).map(
                ([key, item]) => ({
                  label:
                    item.name,

                  value:
                    key,

                  emoji:
                    item.emoji
                })
              ),

              {
                label:
                  "None",

                value:
                  "none",

                emoji:
                  "⏭️"
              }
            );

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                "💬 Social Preference"
              )
          ],

          components: [
            new ActionRowBuilder()
              .addComponents(
                menu
              ),

            backButtonRow()
          ]
        });
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId ===
          "settings_social_select"
      ) {
        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        const selected =
          interaction.values[0] ===
          "none"
            ? null
            : interaction.values[0];

        await updateSingleChoiceRole(
          member,
          SOCIAL,
          selected
        );

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                "✅ Social Preference Updated"
              )
          ],

          components: [
            backButtonRow()
          ]
        });
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "tournament_next"
      ) {
        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        if (
          !isStaff(
            member
          )
        ) {
          return interaction.reply({
            content:
              "❌ Only Ashen staff can advance tournament rounds.",

            flags:
              MessageFlags.Ephemeral
          });
        }

        const state =
          await getActiveTournamentState();

        if (
          !state ||
          state.phase !==
            "battle"
        ) {
          return interaction.reply({
            content:
              "❌ There isn't a battle waiting for the next vote right now.",

            flags:
              MessageFlags.Ephemeral
          });
        }

        const tournament =
          TOURNAMENTS[
            state.tournament
          ];

        if (
          state.round >=
          tournament.rounds
        ) {
          return interaction.reply({
            content:
              "Round 4 is already complete. Use Finish Tournament after the final battle.",

            flags:
              MessageFlags.Ephemeral
          });
        }

        await startTournamentVote(
          state.tournament,
          state.round + 1,
          true
        );

        return interaction.reply({
          content:
            `✅ Round ${state.round + 1} voting opened.`,

          flags:
            MessageFlags.Ephemeral
        });
      }

      if (
        interaction.isButton() &&
        interaction.customId ===
          "tournament_finish"
      ) {
        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        if (
          !isStaff(
            member
          )
        ) {
          return interaction.reply({
            content:
              "❌ Only Ashen staff can finish Tournament Mode.",

            flags:
              MessageFlags.Ephemeral
          });
        }

        const state =
          await getActiveTournamentState();

        if (!state) {
          return interaction.reply({
            content:
              "❌ No active tournament.",

            flags:
              MessageFlags.Ephemeral
          });
        }

        await finishTournament(
          state.tournament
        );

        return interaction.reply({
          content:
            "🏁 Tournament Mode finished. The Live Event Board is back to normal.",

          flags:
            MessageFlags.Ephemeral
        });
      }

    } catch (error) {
      console.error(
        "❌ Interaction error:",
        error
      );

      try {
        if (
          interaction.isRepliable() &&
          !interaction.replied &&
          !interaction.deferred
        ) {
          await interaction.reply({
            content:
              "❌ Something went wrong. Please try again.",

            flags:
              MessageFlags.Ephemeral
          });

        } else if (
          interaction.isRepliable() &&
          interaction.deferred
        ) {
          await interaction.editReply(
            "❌ Something went wrong. Please try again."
          );
        }

      } catch {}
    }
  }
);

// =====================================================
// READY
// =====================================================

client.once(
  Events.ClientReady,

  async readyClient => {
    console.log(
      `✅ ${BOT_NAME} online as ${readyClient.user.tag}`
    );

    try {
      await initDatabase();

    } catch (error) {
      console.error(
        "❌ DATABASE FAILED TO INITIALIZE:",
        error
      );

      return;
    }

    const setupTasks = [
      [
        "Start Here",
        setupStartHere
      ],

      [
        "Onboarding",
        setupOnboardingPanel
      ],

      [
        "Preferences",
        setupPreferences
      ],

      [
        "Help Center",
        setupHelpCenter
      ],

      [
        "Live Event Board",
        setupEventBoard
      ]
    ];

    for (
      const [
        label,
        fn
      ] of setupTasks
    ) {
      try {
        await fn();

        console.log(
          `✅ ${label} ready.`
        );

      } catch (error) {
        console.error(
          `❌ ${label} setup error:`,
          error
        );
      }
    }

    try {
      await runPermissionChecks();

    } catch (error) {
      console.error(
        "❌ Permission audit error:",
        error
      );
    }

    startScheduler();

    console.log(
      "✅ Google Cloud Translation active."
    );

    console.log(
      "✅ Persistent edit/delete/reaction sync active."
    );

    console.log(
      "✅ Synced reply links active across translated channels."
    );

    console.log(
      "✅ Social private Translate buttons active."
    );

    console.log(
      "✅ Primary-language notification delivery active."
    );

    console.log(
      "✅ Sever + Nexus Tournament Mode active."
    );

    console.log(
      "✅ Community Highlights active."
    );
  }
);

// =====================================================
// LOGIN
// =====================================================

client.login(
  process.env.DISCORD_BOT
);
