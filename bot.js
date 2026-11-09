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
import { setupSxsHub } from "./sxsHub.js";

const { Pool } = pg;

// =====================================================
// VESTRA — ASHEN WARRIORS
// =====================================================

const BOT_NAME = "Vestra";
const TZ = "America/Chicago";
const GOOGLE_TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2";
const HIGHLIGHT_REACTION_THRESHOLD = 4;
const BRAND_COLOR = 0x363B41;

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

    `CREATE TABLE IF NOT EXISTS localized_ping_roles (
      source_role_id TEXT NOT NULL,
      language_key TEXT NOT NULL,
      scoped_role_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (source_role_id, language_key)
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
  registration: { name: "Guild Clash Registration", emoji: "⏰", role: "1537936738998296618" },
  chaos_last_call: { name: "Chaos Tyrant Last Call", emoji: "⏳", role: "1569150660363026462" }
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


const ONBOARDING_UI = {"english":{"step":"STEP {n} OF 4","title":["🌎 Set Your Language","🔔 Choose Your Alerts","🎮 Pick Your Playstyle","💬 Set Your Social Vibe"],"note":["Pick the language Vestra should use for your **notifications** and 🌐 reaction translations.\n\nYou can unlock other language chats later in Role Preferences.","Choose **as many as you want** from the guild and Server/Nexus Tournament reminders. You can change these anytime.","This is just for fun and helps others see how you like to play.","There is no wrong answer. This gives the community a hint about how you like to interact."],"review":["✅ Ready to Join Ashen Warriors","Everything looks good! Review your choices, then press **Finish Onboarding**.","🌎 Primary Language","🔔 Pings","🎮 Playstyle","💬 Social Vibe","🔕 No reminders","Not specified","You can change this later in Role Preferences."],"done":["✅ Welcome to Ashen Warriors!","Your roles and Vestra preferences have been saved. The rest of Ashen is open to you.","Head into the server, say hi, and make yourself at home. 🖤"],"choice":["No reminders","Casual","Competitive","Both","Skip","Chatty","Quiet","Either"],"suffix":" Pings","footer":"Vestra | Ashen Induction"},"spanish":{"step":"PASO {n} DE 4","title":["🌎 Elige tu idioma","🔔 Elige tus avisos","🎮 Elige tu estilo de juego","💬 Elige tu estilo social"],"note":["Elige el idioma que Vestra usará para tus **notificaciones** y traducciones con la reacción 🌐.\n\nPodrás acceder a otros canales de idiomas después en las preferencias de roles.","Elige **tantos recordatorios como quieras**, incluidos los de gremio y los torneos de Servidor/Nexus. Puedes cambiarlos cuando quieras.","Es solo por diversión y ayuda a los demás a conocer tu forma de jugar.","No hay respuestas incorrectas. Esto le da a la comunidad una idea de cómo prefieres relacionarte."],"review":["✅ Todo listo para unirte a Ashen Warriors","¡Todo está listo! Revisa tus opciones y pulsa **Finalizar incorporación**.","🌎 Idioma principal","🔔 Avisos","🎮 Estilo de juego","💬 Estilo social","🔕 Sin recordatorios","No especificado","Puedes cambiar estas opciones en las preferencias de roles."],"done":["✅ ¡Bienvenido/a a Ashen Warriors!","Tus roles y preferencias de Vestra están guardados. Ya puedes acceder al resto del servidor.","¡Entra, saluda y disfruta de la comunidad! 🖤"],"choice":["Sin recordatorios","Casual","Competitivo","Ambos","Omitir","Conversador","Reservado","Cualquiera"],"suffix":" — Avisos","footer":"Vestra | Incorporación a Ashen","events":["Reinicio","Conquista matutina","Conquista nocturna","Inicio del Clash","Batalla del Clash","Última llamada del Clash","Inscripción al Clash del gremio","Último aviso del Tirano del Caos","Torneo del servidor","Torneo Nexus"]},"french":{"step":"ÉTAPE {n} SUR 4","title":["🌎 Choisissez votre langue","🔔 Choisissez vos alertes","🎮 Choisissez votre style de jeu","💬 Choisissez votre style social"],"note":["Choisissez la langue que Vestra utilisera pour vos **notifications** et les traductions avec la réaction 🌐.\n\nVous pourrez accéder aux autres salons linguistiques dans les préférences de rôles.","Choisissez **autant de rappels que vous le souhaitez**, pour la guilde et les tournois Serveur/Nexus. Vous pourrez les modifier à tout moment.","Ce choix est juste pour le plaisir et permet aux autres de connaître votre façon de jouer.","Il n'y a pas de mauvaise réponse. Cela aide la communauté à connaître vos préférences d'échange."],"review":["✅ Prêt à rejoindre Ashen Warriors","Tout est prêt ! Vérifiez vos choix, puis appuyez sur **Terminer l’intégration**.","🌎 Langue principale","🔔 Alertes","🎮 Style de jeu","💬 Style social","🔕 Aucun rappel","Non précisé","Vous pourrez modifier ces choix dans les préférences de rôles."],"done":["✅ Bienvenue chez Ashen Warriors !","Vos rôles et préférences Vestra sont enregistrés. Le reste du serveur est maintenant accessible.","Venez saluer la communauté et installez-vous ! 🖤"],"choice":["Aucun rappel","Détente","Compétitif","Les deux","Passer","Bavard","Discret","L'un ou l'autre"],"suffix":" — Alertes","footer":"Vestra | Accueil Ashen","events":["Réinitialisation","Conquête du matin","Conquête du soir","Début du Clash","Bataille du Clash","Dernier appel du Clash","Inscription au Clash de guilde","Dernier appel du Tyran du chaos","Tournoi du serveur","Tournoi Nexus"]},"german":{"step":"SCHRITT {n} VON 4","title":["🌎 Wähle deine Sprache","🔔 Wähle deine Benachrichtigungen","🎮 Wähle deinen Spielstil","💬 Wähle deinen sozialen Stil"],"note":["Wähle die Sprache, die Vestra für deine **Benachrichtigungen** und Übersetzungen über die 🌐-Reaktion verwenden soll.\n\nWeitere Sprachkanäle kannst du später in den Rolleneinstellungen freischalten.","Wähle **so viele Erinnerungen wie du möchtest** für Gildenevents und Server-/Nexus-Turniere. Du kannst sie jederzeit ändern.","Das ist nur zum Spaß und hilft anderen, deinen Spielstil kennenzulernen.","Es gibt keine falsche Antwort. So erfährt die Community, wie du dich am liebsten austauschst."],"review":["✅ Bereit für Ashen Warriors","Alles ist bereit! Überprüfe deine Auswahl und klicke auf **Onboarding abschließen**.","🌎 Hauptsprache","🔔 Benachrichtigungen","🎮 Spielstil","💬 Sozialer Stil","🔕 Keine Erinnerungen","Nicht angegeben","Du kannst dies später in den Rolleneinstellungen ändern."],"done":["✅ Willkommen bei Ashen Warriors!","Deine Rollen und Vestra-Einstellungen sind gespeichert. Der Rest des Servers ist jetzt freigeschaltet.","Sag Hallo und fühl dich wie zu Hause! 🖤"],"choice":["Keine Erinnerungen","Entspannt","Wettbewerbsorientiert","Beides","Überspringen","Gesprächig","Ruhig","Beides"],"suffix":" — Hinweise","footer":"Vestra | Ashen-Einführung","events":["Zurücksetzung","Morgen-Eroberung","Abend-Eroberung","Clash-Beginn","Clash-Kampf","Letzter Clash-Aufruf","Gilden-Clash-Anmeldung","Chaos-Tyrann: Letzter Aufruf","Serverturnier","Nexus-Turnier"]},"portuguese":{"step":"ETAPA {n} DE 4","title":["🌎 Escolha seu idioma","🔔 Escolha seus alertas","🎮 Escolha seu estilo de jogo","💬 Escolha seu estilo social"],"note":["Escolha o idioma que Vestra usará para suas **notificações** e traduções com a reação 🌐.\n\nVocê poderá acessar outros canais de idiomas depois nas preferências de cargos.","Escolha **quantos lembretes quiser** da guilda e dos torneios Servidor/Nexus. Você poderá alterá-los quando quiser.","Isso é só por diversão e ajuda os outros a conhecer seu jeito de jogar.","Não existe resposta errada. Isso ajuda a comunidade a entender como você prefere interagir."],"review":["✅ Pronto(a) para entrar em Ashen Warriors","Tudo certo! Revise suas escolhas e clique em **Concluir integração**.","🌎 Idioma principal","🔔 Alertas","🎮 Estilo de jogo","💬 Estilo social","🔕 Sem lembretes","Não especificado","Você pode mudar essas escolhas depois nas preferências de cargos."],"done":["✅ Boas-vindas a Ashen Warriors!","Seus cargos e preferências do Vestra foram salvos. O restante do servidor já está disponível.","Entre, cumprimente o pessoal e fique à vontade! 🖤"],"choice":["Sem lembretes","Casual","Competitivo","Ambos","Pular","Conversador","Reservado","Qualquer um"],"suffix":" — Alertas","footer":"Vestra | Integração Ashen","events":["Reinício","Conquista da manhã","Conquista da noite","Início do Clash","Batalha do Clash","Última chamada do Clash","Inscrição no Clash da guilda","Última chamada do Tirano do Caos","Torneio do servidor","Torneio Nexus"]},"japanese":{"step":"ステップ {n} / 4","title":["🌎 言語を選択","🔔 通知を選択","🎮 プレイスタイルを選択","💬 交流スタイルを選択"],"note":["Vestraの**通知**と🌐リアクション翻訳に使用する言語を選んでください。\n\nほかの言語チャンネルは後からロール設定で追加できます。","ギルドのリマインダーとサーバー/Nexusトーナメントの通知から、**必要なものをすべて**選んでください。設定はいつでも変更できます。","ほかのメンバーにあなたのプレイスタイルを知ってもらうための気軽な選択です。","正解・不正解はありません。コミュニティでどのように交流したいかを教えてください。"],"review":["✅ Ashen Warriorsへの参加準備完了","設定を確認して、**オンボーディングを完了**を押してください。","🌎 メイン言語","🔔 通知","🎮 プレイスタイル","💬 交流スタイル","🔕 通知なし","未設定","あとからロール設定で変更できます。"],"done":["✅ Ashen Warriorsへようこそ！","ロールとVestraの設定が保存されました。サーバーのほかのチャンネルも利用できます。","気軽にあいさつして交流を楽しんでください！ 🖤"],"choice":["通知なし","カジュアル","競争重視","両方","スキップ","おしゃべり","静か","どちらでも"],"suffix":" — 通知","footer":"Vestra | Ashen参加登録","events":["リセット","朝のコンクエスト","夜のコンクエスト","クラッシュ開始","クラッシュ戦闘","クラッシュ最終案内","ギルドクラッシュ登録","カオスタイラント最終案内","サーバートーナメント","Nexusトーナメント"]}};
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

function onboardingEmbed(step, title, description) {
  return brandEmbed(`${step} · ${title}`, description)
    .setFooter({ text: "Vestra • Ashen Warriors Onboarding" });
}

function onboardingStepContent(step, title, description) {
  return `# ${title}

**${step}**

${description}

*Vestra | Ashen Induction*`;
}

function onboardingSummaryEmbed(session) {
  const language = session.language || "english";
  const copy = onboardingLocale(language);
  const reminderNames = (session.reminders || []).map(key => {
    if (REMINDERS[key]) return localizedOnboardingEvent(language, key);
    if (key.startsWith("tournament:")) return localizedOnboardingEvent(language, key.split(":")[1]);
    return key;
  });
  return brandEmbed(copy.review[0], copy.review[1]).addFields(
    { name: copy.review[2], value: LANGUAGES[language]?.name || copy.review[7], inline: true },
    { name: copy.review[4], value: session.playstyle ? localizedOnboardingChoice(language, session.playstyle) : copy.review[7], inline: true },
    { name: copy.review[5], value: session.social ? localizedOnboardingChoice(language, session.social) : copy.review[7], inline: true },
    { name: copy.review[3], value: reminderNames.join("\n") || copy.review[6] }
  ).setFooter({ text: copy.review[8] });
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

// =====================================================
// START HERE / ONBOARDING / HELP / PREFERENCES
// =====================================================

async function setupStartHere() {
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

async function setupRulesPanel() {
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

async function setupOnboardingPanel() {
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

async function setupHelpCenter() {
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

async function setupGuildPingsPanel() {
  const content = `# ASHEN / ALERT HISTORY
This channel records guild and tournament alerts sent by Vestra.

**DELIVERY**
Your actual notifications appear in your selected language's General channel.

**ARCHIVE**
These records do not send extra role pings. Manage subscriptions in <#${CHANNELS.PREFERENCES}>.`;

  await upsertBotPanel(
    CHANNELS.REMINDERS, "panel_guild_pings",
    { content, embeds: [], components: [] },
    "# ASHEN / ALERT HISTORY"
  );
}

async function setupIntroductionPanel() {
  const content = `# ASHEN / ROSTER
**New members enter here.**

Vestra announces completed inductions with each member's language, playstyle, and social preference.

Welcome new recruits. Make them part of the guild.`;

  await upsertBotPanel(
    CHANNELS.INTRODUCTIONS, "panel_introductions",
    { content, embeds: [], components: [] },
    "# ASHEN / ROSTER"
  );
}

async function setupStaffRequestsPanel() {
  const content = `# ASHEN / COMMAND REQUESTS
**Staff access only.**

Private support requests appear here with the member, submission time, details, and status.

Keep all member information confidential. Vestra notifies leadership when a new request arrives.`;

  await upsertBotPanel(
    CHANNELS.STAFF_REQUESTS, "panel_staff_requests",
    { content, embeds: [], components: [] },
    "# ASHEN / COMMAND REQUESTS"
  );
}

function getAshenMembersChannel(guild) {
  // Target the showcase only, not the similarly named guild directory.
  return guild?.channels?.cache?.find(
    ch => ch.type === ChannelType.GuildText &&
      (ch.name.toLowerCase().includes("ashen-members") || ch.name.toLowerCase().includes("ashen-showcase"))
  ) || null;
}

// Only Ashen staff may publish in the main showcase; other members may
// view it, react, and write in its discussion threads.
async function enforceAshenMembersStaffOnly(guild) {
  const channel = getAshenMembersChannel(guild);
  if (!channel) {
    console.warn("⚠️ #ashen-members unavailable: permissions unchanged.");
    return false;
  }

  const me = guild.members.me || await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    console.error("❌ Vestra needs Manage Roles to set showcase permissions.");
    return false;
  }

  const denyPosting = {
    SendMessages: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false
  };

  await channel.permissionOverwrites.edit(guild.roles.everyone, {
    ...denyPosting,
    ViewChannel: true,
    ReadMessageHistory: true,
    AddReactions: true,
    SendMessagesInThreads: true
  }, { reason: "Only Ashen staff may post; members may comment in threads" });

  for (const id of Object.values(STAFF_ROLES)) {
    const role = guild.roles.cache.get(id);
    if (!role) {
      console.warn("⚠️ Ashen staff role missing: " + id);
      continue;
    }
    await channel.permissionOverwrites.edit(role, {
      SendMessages: true,
      CreatePublicThreads: true,
      SendMessagesInThreads: true
    }, { reason: "Authorize staff showcases" });
  }

  // Remove older direct channel posting exceptions for non-staff.
  for (const overwrite of [...channel.permissionOverwrites.cache.values()]) {
    if (overwrite.id === guild.id ||
        overwrite.id === me.id ||
        Object.values(STAFF_ROLES).includes(overwrite.id)) continue;

    const canPost = overwrite.allow.has(PermissionFlagsBits.SendMessages) ||
      overwrite.allow.has(PermissionFlagsBits.CreatePublicThreads) ||
      overwrite.allow.has(PermissionFlagsBits.CreatePrivateThreads);
    if (!canPost) continue;

    if (overwrite.type === 1) {
      const member = await guild.members.fetch(overwrite.id).catch(() => null);
      if (member && isStaff(member)) continue;
    }
    await channel.permissionOverwrites.edit(overwrite.id, denyPosting, {
      reason: "Remove non-staff showcase posting exceptions"
    });
  }

  // Allow Vestra to manage the channel panel and staff discussion threads.
  await channel.permissionOverwrites.edit(me, {
    SendMessages: true,
    SendMessagesInThreads: true,
    CreatePublicThreads: true,
    ManageThreads: true,
    ReadMessageHistory: true
  }, { reason: "Vestra showcase management" });

  console.log("✅ Ashen Members: staff-only posts, open discussion threads.");
  return true;
}

function ashenPostInfoEmbed(message) {
  const rawCaption = (message.content || "").trim();
  // Mentions in the source post (e.g. <@123>) are kept for attribution.
  const creditPattern = /(?:^|[\s.!?])(?:🎨\s*)?(?:credits?(?:\s+to|\s+by)?|art(?:work)?\s+by|illustration\s+by|created\s+by|made\s+by|artist)\s*[:\-–]?\s*(.+)$/im;
  const match = creditPattern.exec(rawCaption);
  const credits = match?.[1]?.trim() || "Not specified";
  const caption = match ? rawCaption.replace(match[0], "").trim() : rawCaption;
  const attachmentCount = message.attachments?.size || 0;

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle("ASHEN / SHOWCASE")
    .addFields(
      { name: "Posted by", value: "<@" + message.author.id + ">", inline: true },
      { name: "Creator credit", value: limitText(credits, 1024), inline: true },
      { name: "Posted", value: "<t:" + Math.floor(message.createdTimestamp / 1000) + ":f>", inline: false },
      { name: "Attachments", value: attachmentCount ? (attachmentCount + " file" + (attachmentCount === 1 ? "" : "s")) : "None", inline: true },
      { name: "Original post", value: "[View original](" + message.url + ")", inline: true }
    )
    .setFooter({ text: "Vestra • Ashen Members • " + message.id });

  if (caption) embed.addFields({ name: "Caption", value: limitText(caption, 1024) });
  return embed;
}

function ashenDiscussionIntroduction(channelId) {
  return "## DISCUSSION\n" +
    "All discussion belongs in this thread. Keep <#" + channelId +
    "> reserved for staff showcases.";
}

// Reuse Vestra's existing discussion introduction and keep every user message
// and reaction untouched. The embedded details belong to Vestra, not the
// original user's message (which Discord bots cannot edit).
async function upsertAshenDiscussionDetails(message, thread) {
  if (!thread?.isThread?.()) throw new Error("Discussion thread is unavailable.");

  const wasArchived = thread.archived === true;
  if (wasArchived) {
    await thread.setArchived(false, "Updating creator credits and post details");
  }

  try {
    const recent = await thread.messages.fetch({ limit: 100 });
    const footerTag = "Vestra • Ashen Members • " + message.id;
    const detailsMessage = recent.find(m =>
      m.author?.id === client.user?.id &&
      m.embeds?.some(e => e.footer?.text === footerTag)
    );
    const oldIntroduction = recent.find(m =>
      m.author?.id === client.user?.id &&
      (m.content?.startsWith("## 💬 Discuss This Post") || m.content?.startsWith("## DISCUSSION"))
    );
    const existing = detailsMessage || oldIntroduction;
    const data = { content: ashenDiscussionIntroduction(message.channel.id), embeds: [ashenPostInfoEmbed(message)], allowedMentions: { parse: [] } };

    if (existing) {
      await existing.edit(data);
      return "updated";
    }

    await thread.send({
      content: ashenDiscussionIntroduction(message.channel.id),
      ...data
    });
    return "created";
  } finally {
    if (wasArchived && !thread.archived) {
      await thread.setArchived(true, "Restore original discussion archive status")
        .catch(error => console.warn("⚠️ Could not rearchive discussion " + thread.id + ": " + error.message));
    }
  }
}

async function refreshAshenMembersPostInfo(message) {
  const channel = getAshenMembersChannel(message.guild);
  if (!channel || message.channel.id !== channel.id || !message.hasThread) return;

  const thread = message.thread ||
    await message.guild.channels.fetch(message.id).catch(() => null);
  if (!thread?.isThread?.()) return;

  // On post edits, refresh the credit details in the existing thread.
  await upsertAshenDiscussionDetails(message, thread).catch(error => {
    console.error("❌ Could not refresh Ashen post credits:", error.message);
  });
}

async function ensureAshenMembersDiscussion(message) {
  if (!message?.guild || message.author?.bot || message.webhookId) {
    return false;
  }

  const showcaseChannel = getAshenMembersChannel(message.guild);

  if (!showcaseChannel || message.channel.id !== showcaseChannel.id) {
    return false;
  }

  const member = message.member ||
    await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!isStaff(member)) {
    // Permissions should block this; the guard catches older exceptions.
    console.warn("⚠️ Non-staff showcase post rejected: " + message.author.id);
    await message.delete().catch(error =>
      console.error("❌ Could not remove unauthorized post:", error.message)
    );
    return true;
  }

  // If someone replies in the main feed, move the discussion into the
  // original showcase post's thread instead of letting replies pile up.
  if (message.reference?.messageId) {
    const sourceMessage = await showcaseChannel.messages
      .fetch(message.reference.messageId)
      .catch(() => null);

    if (sourceMessage?.hasThread && sourceMessage.thread) {
      const attachmentText = [...message.attachments.values()]
        .map(attachment => attachment.url)
        .join("\n");

      const movedText = [
        `**<@${message.author.id}> replied:**`,
        message.content || "",
        attachmentText
      ]
        .filter(Boolean)
        .join("\n");

      await sourceMessage.thread
        .send({
          content: movedText,
          allowedMentions: {
            users: [message.author.id]
          }
        })
        .catch(() => null);

      await message.delete().catch(() => {});

      const notice = await showcaseChannel
        .send({
          content:
            `💬 <@${message.author.id}>, I moved your reply into ` +
            `<#${sourceMessage.thread.id}> so **Ashen Members** stays clean.`,
          allowedMentions: {
            users: [message.author.id]
          }
        })
        .catch(() => null);

      if (notice) {
        setTimeout(() => {
          void notice.delete().catch(() => {});
        }, 8_000);
      }

      return true;
    }
  }

  // Every top-level showcase post gets one discussion thread.
  if (!message.hasThread) {
    const thread = await message
      .startThread({
        // Discord requires an initial name to create a discussion thread.
        // Staff can rename it manually; Vestra never changes it afterward.
        name: "Discussion",
        autoArchiveDuration: 1440,
        reason: "Keep Ashen Members showcase discussion organized"
      })
      .catch(error => {
        console.error(
          "❌ Could not create Ashen Members discussion thread:",
          error.message
        );
        return null;
      });

    if (thread) {
      await upsertAshenDiscussionDetails(message, thread).catch(error => {
        console.error("❌ Could not send Ashen post details:", error.message);
      });
      // Keep the original thread name. Discord generates a non-deletable
      // system message whenever a thread is renamed, so never automatically
      // rename live Ashen threads after creation. Existing custom names stay.
    }
  }

  return true;
}

async function setupGuildMembersPanel() {
  const guild = getGuild();
  if (!guild) return;
  const channel = getAshenMembersChannel(guild);
  if (!channel) return;

  await guild.members.fetch().catch(() => {});
  const humanMembers = guild.members.cache.filter(member => !member.user.bot);
  const staffCount = humanMembers.filter(member => isStaff(member)).size;
  const onboardedCount = humanMembers.filter(
    member => member.roles.cache.has(ONBOARDING_COMPLETE)
  ).size;

  const content = `# ASHEN / SHOWCASE
**Official guild showcase.**

**POSTING**
Only Ashen staff may publish artwork, battle records, event graphics, achievements, or guild highlights. Members may view and react.

**DISCUSSION**
Vestra creates a thread for each staff post. All replies belong in that thread.

**CREDITS**
Credit the original creator using "Credits to @artist" or "Art by @artist" in the caption. Vestra records the credit alongside the post details.

**ROSTER**
${humanMembers.size} members · ${staffCount} staff · ${onboardedCount} inducted

Use the profile button to view your Vestra settings and roles.`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("settings_card")
      .setLabel("View Profile").setStyle(ButtonStyle.Primary)
  );

  await upsertBotPanel(
    channel, "panel_guild_members",
    { content, embeds: [], components: [row] },
    "# ASHEN / SHOWCASE"
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
    `${type}`,
    details
  )
    .addFields({
      name: "Requested by",
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
    content: `${interaction.member}, your support thread is ready.`,
    allowedMentions: {
      parse: [],
      users: [interaction.user.id]
    }
  });

  await interaction.reply({
    content: `Request received: ${thread}`,
    flags: MessageFlags.Ephemeral
  });
}

// =====================================================
// WELCOME / MEMBER CARDS
// =====================================================

function welcomeCard(member, languageName, playstyleName, socialName) {
  return brandEmbed(
    "ASHEN | NEW RECRUIT",
    `**${member.displayName}** has completed induction and joined the ranks.`
  )
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "Language", value: languageName, inline: true },
      { name: "Playstyle", value: playstyleName, inline: true },
      { name: "Social", value: socialName, inline: true }
    )
    .setFooter({ text: "Vestra | Ashen Roster" })
    .setTimestamp();
}

async function memberCardEmbed(member) {
  const primary = await inferPrimaryLanguage(member);
  const languageAccess = LANGUAGE_KEYS
    .filter(key => member.roles.cache.has(LANGUAGE_CHANNELS[key].role))
    .map(key => LANGUAGE_CHANNELS[key].name);
  const reminders = Object.values(REMINDERS)
    .filter(item => member.roles.cache.has(item.role))
    .map(item => item.name);
  const tournaments = Object.values(TOURNAMENTS)
    .filter(item => member.roles.cache.has(item.role))
    .map(item => item.name);
  const playstyle = Object.values(PLAYSTYLE)
    .find(item => member.roles.cache.has(item.role))?.name || "Not set";
  const social = Object.values(SOCIAL)
    .find(item => member.roles.cache.has(item.role))?.name || "Not set";

  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(`ASHEN | ${member.displayName}`)
    .setDescription(`${LANGUAGE_CHANNELS[primary].name} · ${playstyle} · ${social}`)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "Notification language", value: LANGUAGE_CHANNELS[primary].name },
      { name: "Language access", value: languageAccess.join(", ") || "None" },
      { name: "Playstyle", value: playstyle, inline: true },
      { name: "Social", value: social, inline: true },
      { name: "Guild alerts", value: reminders.join(", ") || "None" },
      { name: "Tournament alerts", value: tournaments.join(", ") || "None" }
    )
    .setFooter({ text: "Vestra | Ashen Profile" });
}

// =====================================================
// SETTINGS PANEL
// =====================================================

function settingsHomeComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("settings_languages").setLabel("Language Access").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("settings_notify").setLabel("Notification Language").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("settings_reminders").setLabel("Guild Pings").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("settings_tournaments").setLabel("Tournament Pings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("settings_playstyle").setLabel("Playstyle").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("settings_social").setLabel("Social").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("settings_card").setLabel("My Vestra Card").setStyle(ButtonStyle.Success)
    )
  ];
}

function settingsHomeEmbed() {
  return brandEmbed(
    "VESTRA | SETTINGS",
    "Manage your access, alerts, and member profile."
  ).addFields(
    { name: "Language", value: "Channel access and notification language", inline: true },
    { name: "Alerts", value: "Guild and tournament subscriptions", inline: true },
    { name: "Profile", value: "Playstyle and social preference", inline: true }
  ).setFooter({ text: "Vestra | Changes save immediately" });
}

function backButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("settings_back").setLabel("Back").setStyle(ButtonStyle.Secondary)
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
  const makeTranslationEmbed = (temporary, secondsRemaining = 30) => {
    const translationEmbed = new EmbedBuilder()
      .setAuthor({
        name: safeDisplayName(message.member, message.author),
        iconURL: message.author?.displayAvatarURL?.({ size: 128 }) || undefined
      })
      .setTitle(`${target.emoji} Translation → ${target.name}`)
      .setDescription(limitText(translated, 3900));

    if (temporary) {
      translationEmbed.addFields({
        name: "⏳ Translation disappears in",
        value: secondsRemaining + (secondsRemaining === 1 ? " second" : " seconds")
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

  // Discord's <t:...:R> is not a seconds-resolution countdown.
  // Update the same embed every second and delete it at the 30-second mark.
  const expiresAtMs = Date.now() + SOCIAL_TRANSLATION_DELETE_MS;
  let active = true;
  let editInFlight = false;
  let shownSeconds = 30;
  const countdown = setInterval(() => {
    if (!active || editInFlight) return;
    const remaining = Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
    if (remaining < 1 || remaining === shownSeconds) return;

    editInFlight = true;
    void translatedReply.edit({ embeds: [makeTranslationEmbed(true, remaining)] })
      .then(() => { shownSeconds = remaining; })
      .catch(error => {
        // If the message was removed or editing is no longer permitted,
        // stop updating; the deletion timeout still handles cleanup.
        console.warn("🌐 Translation countdown update failed:", error.message);
        if (error.code === 10008 || error.code === 50013) {
          active = false;
          clearInterval(countdown);
        }
      })
      .finally(() => { editInFlight = false; });
  }, 1000);

  setTimeout(() => {
    active = false;
    clearInterval(countdown);
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
    .setTitle("ASHEN | DISTINGUISHED")
    .setAuthor({
      name: safeDisplayName(sourceMessage.member, sourceMessage.author),
      iconURL: sourceMessage.author.displayAvatarURL({ size: 128 })
    })
    .setDescription(limitText(sourceMessage.content || "*(attachment / media post)*", 3500))
    .addFields(
      { name: "Community recognition", value: reactionText || `${score} reactions`, inline: true },
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
  },
  {
    key: "chaos_tyrant_last_call",
    label: "Chaos Tyrant Last Call",
    role: REMINDERS.chaos_last_call.role,
    days: [0],
    winter: [20,0],
    summer: [21,0],
    text: "⏳ Chaos Tyrant: Last call! One hour remains before Chaos closes.",
    nonNexusSunday: true
  }
];

function eventTimeForDate(event, y, m, d) {
  return isCentralDSTDate(y, m, d) ? event.summer : event.winter;
}

function eventApplies(event, y, m, d, weekday) {
  if (!event.days.includes(weekday)) return false;
  if (event.alternateSunday && !isNexusSunday(y, m, d)) return false;
  if (event.nonNexusSunday && isNexusSunday(y, m, d)) return false;
  return true;
}

// =====================================================
// LOCALIZED NOTIFICATION DELIVERY
// =====================================================

function formatAlertHistoryMessage(roleId, label, text, deliveredCount) {
  const displayedRole = roleId ? `<@&${roleId}>` : "";
  return [
    [displayedRole, `**${label}**`].filter(Boolean).join(" "),
    text || "Event notification sent.",
    "",
    Number.isInteger(deliveredCount)
      ? `🌎 Vestra delivered ${deliveredCount} localized notifications.`
      : "🌎 Localized delivery count was not recorded."
  ].join("\n");
}

async function sendMasterLog(roleId, label, text, deliveredCount) {
  const channel = await client.channels.fetch(CHANNELS.REMINDERS).catch(() => null);
  if (!channel?.isTextBased()) throw new Error("#alert-history is unavailable");

  // This archival copy must not generate another ping.
  await channel.send({
    content: formatAlertHistoryMessage(roleId, label, text, deliveredCount),
    allowedMentions: { parse: [] }
  });
}

// Convert Vestra's old boxed event-log embeds into the same compact
// text format without deleting/reposting messages or changing timestamps.
async function migrateLegacyAlertHistory() {
  const completionKey = "alert_history_plaintext_migration_v1";
  if ((await dbGetState(completionKey))?.completed) return;

  const channel = await client.channels.fetch(CHANNELS.REMINDERS).catch(() => null);
  if (!channel?.isTextBased() || !channel.messages?.fetch) {
    console.warn("⚠️ Alert history cleanup postponed: channel unavailable.");
    return;
  }

  let before;
  let inspected = 0;
  let converted = 0;
  let failed = 0;
  let skipped = 0;

  while (true) {
    const page = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    });

    if (!page.size) break;

    for (const message of page.values()) {
      inspected++;
      if (message.author.id !== client.user.id) continue;

      // Leave the important #alert-history information panel alone.
      if (message.content?.includes("# 🔔 Ashen Guild Ping Log")) continue;

      const embed = message.embeds?.find(e => {
        const fieldNames = (e.fields || []).map(f => f.name || "");
        return (
          e.title?.startsWith("🔔 ") &&
          fieldNames.some(name => name.includes("Localized Delivery")) &&
          fieldNames.some(name => name.includes("Subscriber Role"))
        );
      });
      if (!embed) continue;

      const roleField = embed.fields.find(field => field.name.includes("Subscriber Role"));
      const deliveryField = embed.fields.find(field => field.name.includes("Localized Delivery"));
      const roleId = roleField?.value?.match(/<@&(\d+)>/)?.[1] || null;
      const reportedCount = deliveryField?.value?.match(/(\d+)\s+members?\s+notified/i);
      const count = reportedCount ? Number(reportedCount[1]) : null;
      const label = embed.title.slice("🔔 ".length).trim();
      const content = formatAlertHistoryMessage(
        roleId,
        label,
        embed.description || "Event notification sent.",
        count
      );

      try {
        await message.edit({
          content,
          embeds: [],
          allowedMentions: { parse: [] }
        });
        converted++;
      } catch (error) {
        failed++;
        console.error(`❌ Could not convert alert-history message ${message.id}:`, error.message);
      }
    }

    before = page.last()?.id;
    if (!before) throw new Error("Alert-history pagination stopped unexpectedly.");
    if (page.size < 100) break;
  }

  // A failed edit may be retried at the next restart; already-converted
  // messages have no embedded alert to convert a second time.
  if (failed === 0) {
    await dbSetState(completionKey, { completed: true, inspected, converted });
  }
  console.log(`✅ Alert history cleanup: ${converted} converted, ${failed} failed, ${inspected} scanned.`);
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

// A Discord role mention alerts EVERY member holding that role who can
// see the channel. Using the original subscription role in six channels
// would therefore ping multilingual members multiple times. Maintain a
// separate, non-hoisted role for each event + preferred-language cohort.
async function getScopedPingRoles(guild, subscriptionRole, activeLanguages) {
  const rows = await pool.query(
    "SELECT language_key, scoped_role_id FROM localized_ping_roles WHERE source_role_id = $1",
    [subscriptionRole.id]
  );
  const known = new Map(rows.rows.map(row => [row.language_key, row.scoped_role_id]));
  const roles = new Map();

  for (const key of LANGUAGE_KEYS) {
    const existingId = known.get(key);
    if (!existingId && !activeLanguages.has(key)) continue;

    let helperRole = existingId
      ? await guild.roles.fetch(existingId).catch(() => null)
      : null;

    if (!helperRole && activeLanguages.has(key)) {
      const info = LANGUAGE_CHANNELS[key];
      helperRole = await guild.roles.create({
        name: `${subscriptionRole.name.slice(0, 70)} · ${info.name}`,
        hoist: false,
        mentionable: false,
        reason: "Notify subscribers once in their primary language"
      });
      await pool.query(
        `INSERT INTO localized_ping_roles(source_role_id, language_key, scoped_role_id)
         VALUES($1, $2, $3)
         ON CONFLICT (source_role_id, language_key)
         DO UPDATE SET scoped_role_id = EXCLUDED.scoped_role_id`,
        [subscriptionRole.id, key, helperRole.id]
      );
    }
    if (helperRole) roles.set(key, helperRole);
  }
  return roles;
}

async function syncScopedPingRoles(guild, scopedRoles, recipientsByLanguage) {
  // Reconcile EVERY previously-created cohort for this event, including
  // empty cohorts. Finish all removals before sending a single role ping.
  for (const [key, scopedRole] of scopedRoles) {
    const expected = new Set((recipientsByLanguage.get(key) || []).map(m => m.id));
    for (const member of [...scopedRole.members.values()]) {
      if (!expected.has(member.id)) {
        await member.roles.remove(scopedRole, "No longer subscribed to this event in this language");
      }
    }
    for (const id of expected) {
      const member = guild.members.cache.get(id);
      if (!member) throw new Error("Cannot resolve localized notification subscriber " + id);
      if (!member.roles.cache.has(scopedRole.id)) {
        await member.roles.add(scopedRole, "Event alerts in preferred language");
      }
    }
  }
}

async function sendScopedRolePing(channel, helperRole, text) {
  const canMentionAllRoles =
    !!channel.permissionsFor(client.user)?.has(PermissionFlagsBits.MentionEveryone);
  let temporarilyMentionable = false;

  if (!helperRole.mentionable && !canMentionAllRoles) {
    // A bot without Mention All Roles may temporarily enable this specific
    // helper role; restore it immediately after the message is sent.
    await helperRole.setMentionable(true, "Send primary-language guild notification");
    temporarilyMentionable = true;
  }

  try {
    await channel.send({
      content: `<@&${helperRole.id}>\n${text}`,
      allowedMentions: {
        parse: [],
        roles: [helperRole.id],
        users: [],
        repliedUser: false
      }
    });
  } finally {
    if (temporarilyMentionable) {
      await helperRole.setMentionable(false, "Restore private notification helper role")
        .catch(error => console.error("Could not restore scoped role mentionability:", error));
    }
  }
}

async function sendLocalizedRoleNotification(roleId, englishText, label) {
  const guild = getGuild();
  if (!guild) return 0;
  await guild.members.fetch();

  const subscriptionRole = await guild.roles.fetch(roleId).catch(() => null);
  if (!subscriptionRole) {
    console.error("Notification role missing: " + roleId);
    await sendMasterLog(roleId, label, englishText, 0).catch(console.error);
    return 0;
  }

  const subscribers = subscriptionRole.members.filter(m => !m.user.bot);
  const prefs = await loadPrimaryLanguageMap([...subscribers.keys()]);
  const byLanguage = new Map(LANGUAGE_KEYS.map(key => [key, []]));
  for (const member of subscribers.values()) {
    const key = inferPrimaryFromRoles(member, prefs);
    byLanguage.get(key)?.push(member);
  }

  const deliveries = [];
  const reachableByLanguage = new Map();
  for (const [key, recipients] of byLanguage) {
    if (!recipients.length) continue;

    const info = LANGUAGE_CHANNELS[key];
    const channel = await client.channels.fetch(info.channel).catch(() => null);
    if (!channel?.isTextBased()) {
      console.error("Missing " + info.name + " General channel for " + label);
      continue;
    }

    const reachable = [];
    for (const member of recipients) {
      if (await ensureLanguageAccess(member, key)) reachable.push(member);
      else console.warn(label + ": " + member.id + " cannot view " + info.name + " General");
    }
    if (!reachable.length) continue;

    reachableByLanguage.set(key, reachable);
    deliveries.push({ key, info, channel, reachable });
  }

  // Fail closed: if any role membership cannot be reconciled, send the
  // translated announcement without mentions rather than risk double pings.
  let scopedRoles = new Map();
  let rolesReady = true;
  try {
    scopedRoles = await getScopedPingRoles(
      guild, subscriptionRole, new Set(reachableByLanguage.keys())
    );
    await syncScopedPingRoles(guild, scopedRoles, reachableByLanguage);
    for (const key of reachableByLanguage.keys()) {
      if (!scopedRoles.has(key)) throw new Error("Missing locale role for " + key);
    }
  } catch (error) {
    rolesReady = false;
    console.error("Failed to synchronize preferred-language notification roles:", error);
  }

  let delivered = 0;
  for (const {key, info, channel, reachable} of deliveries) {
    let localized = englishText;
    if (key !== "english") {
      try {
        localized = await googleTranslate(englishText, info.code, "en");
      } catch (error) {
        console.error("Notification translation fallback (" + key + "):", error.message);
      }
    }

    try {
      if (rolesReady) {
        await sendScopedRolePing(channel, scopedRoles.get(key), localized);
        delivered += reachable.length;
      } else {
        await channel.send({
          content: localized,
          allowedMentions: { parse: [], users: [], roles: [] }
        });
      }
    } catch (error) {
      console.error("Role ping failed (" + label + " / " + key + "):", error);
      // A role permission error must not accidentally ping the global
      // subscription role or expose a long list of member mentions.
    }
  }

  console.log(
    `${label}: ${subscribers.size} subscribers, ${delivered} localized role notifications.`
  );
  // The archive does not ping and should not cause a scheduled event to
  // retry (and double notify) when the log channel is unavailable.
  await sendMasterLog(roleId, label, englishText, delivered)
    .catch(error => console.error("Notification archive failed:", error));
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
    categoryByName(["WELCOME TO ASHEN", "ASHEN | ENTRY"]);

  if (!welcome) {
    welcome = await createCategory("ASHEN | ENTRY");
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
        (ch.name.includes("ashen-showcase") || ch.name.includes("ashen-members") || ch.name.includes("guild-members"))
    ) || null;

    await moveKnownChannel(guildMembers, welcome);
  }

  // ASHEN INFO
  let info =
    categoryById(IMPORTANT_CATEGORY_ID) ||
    categoryByName(["ASHEN INFO", "ASHEN | COMMAND"]);

  if (!info) {
    info = await createCategory("ASHEN | COMMAND");
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
    sxs = await createCategory("SWORD X STAFF | OPERATIONS");
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
    categoryByName(["ASHEN SOCIAL", "ASHEN | COMMONS"]);

  if (!social) {
    social = await createCategory("ASHEN | COMMONS");
  }

  if (social) {
    SOCIAL_CATEGORY_ID = social.id;

    for (const id of SOCIAL_CHANNELS) {
      await moveKnownChannel(byId(id), social);
    }
  }

  // ASHEN VOICE
  let voice = categoryByName(["ASHEN VOICE", "VOICE CALLS", "ASHEN | VOICE"]);

  if (!voice) {
    voice = await createCategory("ASHEN | VOICE");
  }

  if (voice) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildVoice) continue;

      const name = channel.name.toLowerCase();

      if (
        name === "general" ||
        name.includes("gaming") || name.includes("squad") ||
        name.includes("boss grinds") || name.includes("boss runs") ||
        name.includes("admins") || name.includes("command")
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

// Deliberately disabled: staff rename channels and categories manually.
// This guard is kept for compatibility but never changes server state.
async function applyAshenSidebarTheme(guildOverride = null) {
  return {
    guildName: guildOverride?.name || null,
    guildId: guildOverride?.id || null,
    renamed: [], removed: [], skipped: [], failed: []
  };
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

    if (await ensureAshenMembersDiscussion(message)) {
      return;
    }

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
    await refreshAshenMembersPostInfo(newMessage);
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
    // Old persistent buttons can survive prior deployments. Do not rename.
    if (interaction.isButton() && interaction.customId === "admin_apply_theme") {
      return interaction.reply({
        content: "Automatic name changes are disabled. Ashen staff control channel names manually.",
        flags: MessageFlags.Ephemeral
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
          `🔔 **Guild and tournament pings:** <#${CHANNELS.PREFERENCES}>\n` +
          "🌐 **Quick translation:** in supported text channels, react 🌐 to a message and Vestra will temporarily translate it into your primary language.\n" +
          "🛡️ **Private staff help:** use Ask Staff in this Help Center.",
        flags: MessageFlags.Ephemeral
      });
    }
    if (interaction.isButton() && interaction.customId === "help_guide") {
      return interaction.reply({
        content:
          `# 🧭 Ashen Server Guide\n\n📍 <#${CHANNELS.START_HERE}> — Start here\n📜 <#${CHANNELS.RULES}> — Rules\n🌎 <#${CHANNELS.ONBOARDING}> — Onboarding\n✨ <#${CHANNELS.PREFERENCES}> — Vestra settings and alert subscriptions\n👋 <#${CHANNELS.INTRODUCTIONS}> — Introductions\n🆘 <#${CHANNELS.HELP}> — Help Center`,
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
            name: "Member",
            value: `${interaction.member}`,
            inline: true
          },
          {
            name: "Username",
            value: interaction.user.username,
            inline: true
          },
          {
            name: "Status",
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
        content: onboardingStageContent("english", 1),
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
        content: onboardingStageContent(language, 2),
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
        content: onboardingStageContent(session.language, 3),
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
        content: onboardingStageContent(session.language, 4),
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

      return interaction.editReply({
        content: onboardingReviewContent(session),
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
        content: onboardingCompleteContent(session.language),
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
        embeds: [new EmbedBuilder().setTitle("LANGUAGE ACCESS").setDescription("Choose every General language channel you want to see.")],
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
        embeds: [new EmbedBuilder().setTitle("NOTIFICATION LANGUAGE").setDescription("Vestra sends your event pings **once**, in this language's General channel.")],
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
        .setPlaceholder("Select guild alerts")
        .setMinValues(1)
        .setMaxValues(Object.keys(REMINDERS).length + 1)
        .addOptions(
          ...Object.entries(REMINDERS).map(([key, item]) => ({ label: item.name, value: key, emoji: item.emoji, default: selected.includes(key) })),
          { label: "No game pings", value: "none", emoji: "🔕", default: selected.length === 0 }
        );
      return interaction.update({
        embeds: [new EmbedBuilder().setTitle("⏰ Guild Pings").setDescription("Choose the guild reminders you want to receive in your preferred language.")],
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
        embeds: [new EmbedBuilder().setTitle("TOURNAMENT ALERTS").setDescription("Opt in to Server Tournament, Nexus Tournament, both, or neither.")],
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
      return interaction.update({ embeds: [new EmbedBuilder().setTitle("PLAYSTYLE")], components: [new ActionRowBuilder().addComponents(menu), backButtonRow()] });
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
      return interaction.update({ embeds: [new EmbedBuilder().setTitle("SOCIAL")], components: [new ActionRowBuilder().addComponents(menu), backButtonRow()] });
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
    // STAFF-CONFIRMED CONQUEST SECOND RUN
    // -------------------------------------------------
    if (interaction.isButton() && interaction.customId === "conquest_second_run") {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!isStaff(member)) {
        return interaction.reply({
          content: "Only Ashen staff can send a second-run Conquest alert.",
          flags: MessageFlags.Ephemeral
        });
      }

      const menu = new StringSelectMenuBuilder()
        .setCustomId("conquest_second_run_select")
        .setPlaceholder("Choose which Conquest second run is starting")
        .addOptions([
          { label: "Morning Conquest — Run 2", value: "morning", emoji: "🌅" },
          { label: "Night Conquest — Run 2", value: "night", emoji: "🌌" }
        ]);
      return interaction.reply({
        content: "Select the Conquest run to notify. Each second-run alert can be sent only once per day.",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.isStringSelectMenu() &&
        interaction.customId === "conquest_second_run_select") {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!isStaff(member)) {
        return interaction.reply({
          content: "Only Ashen staff can send a second-run Conquest alert.",
          flags: MessageFlags.Ephemeral
        });
      }

      const selected = interaction.values[0];
      if (selected !== "morning" && selected !== "night") {
        return interaction.reply({
          content: "Invalid Conquest selection.",
          flags: MessageFlags.Ephemeral
        });
      }

      const event = SCHEDULED_EVENTS.find(item => item.key === selected);
      const now = chicagoParts();
      const [firstHour, firstMinute] = eventTimeForDate(
        event, now.year, now.month, now.day
      );
      if (now.hour * 60 + now.minute < firstHour * 60 + firstMinute) {
        return interaction.reply({
          content: "The scheduled first-run Conquest alert has not started yet.",
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Atomic claim avoids multiple staff clicks issuing duplicate run-2 pings.
      // Claim before sending; don't auto-retry a possibly partial delivery.
      const claimKey = dateKey(now) + ":conquest_second_run:" + selected;
      const claimed = await pool.query(
        "INSERT INTO sent_events(event_key) VALUES($1) " +
        "ON CONFLICT(event_key) DO NOTHING RETURNING event_key",
        [claimKey]
      );
      if (!claimed.rowCount) {
        return interaction.editReply(
          (selected === "morning" ? "Morning" : "Night") +
          " Conquest second-run alert was already triggered today."
        );
      }

      const title = selected === "morning" ? "Morning Conquest" : "Night Conquest";
      const text = selected === "morning"
        ? "🌅 Morning Conquest — Second run is starting now!"
        : "🌌 Night Conquest — Second run is starting now!";

      try {
        const recipients = await sendLocalizedRoleNotification(
          REMINDERS[selected].role, text, title + " — Second Run"
        );
        return interaction.editReply(
          title + " second-run alert sent. " +
          recipients + " subscriber(s) included in preferred-language groups."
        );
      } catch (error) {
        console.error("Conquest second-run manual alert failure:", error);
        return interaction.editReply(
          "The alert encountered an error. Today's second-run action is " +
          "locked to prevent accidental duplicate notifications; check Vestra's logs."
        );
      }
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
      return interaction.reply({ content: "Tournament closed. The War Board has returned to the standard schedule.", flags: MessageFlags.Ephemeral });
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

// Bot username and nickname are also controlled manually by staff.
// Vestra deliberately does not change identity names during startup.

// =====================================================
// READY
// =====================================================

client.once(Events.ClientReady, async readyClient => {
  console.log(`✅ ${BOT_NAME} online as ${readyClient.user.tag}`);

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
    ["Guild Ping Log", setupGuildPingsPanel],
    ["Live Event Board", setupEventBoard],
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

  startScheduler();

  // Safe one-time migration of Vestra's existing event logs. Runs after
  // scheduled notifications are enabled so history cleanup cannot delay them.
  void migrateLegacyAlertHistory().catch(error => {
    console.error("❌ Could not complete old alert-history conversion:", error);
  });

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
});

// =====================================================
// LOGIN
// =====================================================

client.login(process.env.DISCORD_BOT);