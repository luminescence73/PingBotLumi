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
  MessageFlags
} from "discord.js";

import cron from "node-cron";

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
    Partials.Reaction
  ]
});

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

  STAFF_REQUESTS: "1540870724242120776"
};

// =====================================================
// LANGUAGE CHAT CHANNELS
// =====================================================

const LANGUAGE_CHANNELS = {
  english: {
    code: "en",
    name: "English",
    emoji: "🇺🇸",
    channel: "1507565773336481966"
  },

  spanish: {
    code: "es",
    name: "Spanish",
    emoji: "🇪🇸",
    channel: "1540387246752931900"
  },

  french: {
    code: "fr",
    name: "French",
    emoji: "🇫🇷",
    channel: "1540387342408351924"
  },

  german: {
    code: "de",
    name: "German",
    emoji: "🇩🇪",
    channel: "1540387464542167202"
  },

  portuguese: {
    code: "pt",
    name: "Portuguese",
    emoji: "🇵🇹",
    channel: "1540387524709589002"
  },

  japanese: {
    code: "ja",
    name: "Japanese",
    emoji: "🇯🇵",
    channel: "1540387566480531537"
  }
};

// =====================================================
// CORE ROLES
// =====================================================

const ASHEN_WARRIORS = "1507567323161038899";
const ONBOARDING_COMPLETE = "1540336639635628032";

// =====================================================
// STAFF ROLES
// =====================================================

const STAFF_ROLES = {
  LEADER: "1508987283934543992",
  DEPUTY: "1507567404836847747",
  OFFICERS: "1507567452391870544"
};

// =====================================================
// PROTECTED ROLES
// =====================================================

const PROTECTED_ROLES = new Set([
  "1507567387774423171", // Owner
  "1507567296447516714", // Admin
  "1508987283934543992", // Leader
  "1507567404836847747", // Deputy
  "1507567452391870544"  // Officers
]);

// =====================================================
// LANGUAGES
// =====================================================

const LANGUAGES = {
  english: {
    name: "English",
    emoji: "🇺🇸",
    role: "1540336707520434176"
  },

  spanish: {
    name: "Spanish",
    emoji: "🇪🇸",
    role: "1540336749866131476"
  },

  french: {
    name: "French",
    emoji: "🇫🇷",
    role: "1540337010609365073"
  },

  german: {
    name: "German",
    emoji: "🇩🇪",
    role: "1540337119493357668"
  },

  portuguese: {
    name: "Portuguese",
    emoji: "🇵🇹",
    role: "1540337336087482501"
  },

  japanese: {
    name: "Japanese",
    emoji: "🇯🇵",
    role: "1540337389900271676"
  }
};

// =====================================================
// PLAYSTYLE
// =====================================================

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

// =====================================================
// SOCIAL
// =====================================================

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

// =====================================================
// REMINDERS
// =====================================================

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

// =====================================================
// ROLES PINGBOT MAY RESET
// =====================================================

const RESETTABLE_ROLES = new Set([
  ASHEN_WARRIORS,
  ONBOARDING_COMPLETE,

  ...Object.values(LANGUAGES).map(x => x.role),
  ...Object.values(PLAYSTYLE).map(x => x.role),
  ...Object.values(SOCIAL).map(x => x.role),
  ...Object.values(REMINDERS).map(x => x.role)
]);

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
// ONBOARDING MENUS
// =====================================================

function languageMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("onboard_language")
      .setPlaceholder("🌎 Choose your language")
      .addOptions(
        Object.entries(LANGUAGES).map(([key, item]) => ({
          label: item.name,
          value: key,
          emoji: item.emoji
        }))
      )
  );
}

function reminderMenu(language) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("onboard_reminders")
      .setPlaceholder(TEXT[language].reminders)
      .setMinValues(1)
      .setMaxValues(8)
      .addOptions(
        ...Object.entries(REMINDERS).map(([key, item]) => ({
          label: item.name,
          value: key,
          emoji: item.emoji
        })),
        {
          label: "No reminders",
          value: "none",
          emoji: "🔕"
        }
      )
  );
}

function playstyleMenu(language) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("onboard_playstyle")
      .setPlaceholder(TEXT[language].playstyle)
      .addOptions(
        {
          label: "Casual",
          value: "casual",
          emoji: "🌿"
        },
        {
          label: "Competitive",
          value: "competitive",
          emoji: "⚔️"
        },
        {
          label: "Both",
          value: "both",
          emoji: "🎮"
        },
        {
          label: "Skip",
          value: "skip",
          emoji: "⏭️"
        }
      )
  );
}

function socialMenu(language) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("onboard_social")
      .setPlaceholder(TEXT[language].social)
      .addOptions(
        {
          label: "Chatty",
          value: "chatty",
          emoji: "💬"
        },
        {
          label: "Quiet",
          value: "quiet",
          emoji: "🌙"
        },
        {
          label: "Either",
          value: "either",
          emoji: "✨"
        },
        {
          label: "Skip",
          value: "skip",
          emoji: "⏭️"
        }
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
// ONBOARDING PANEL
// =====================================================

async function setupOnboardingPanel() {
  const channel = await client.channels.fetch(
    CHANNELS.ONBOARDING
  );

  if (!channel?.isTextBased()) return;

  const messages = await channel.messages.fetch({
    limit: 50
  });

  const old = messages.find(
    m =>
      m.author.id === client.user.id &&
      m.content.includes("ASHEN_ONBOARDING_PANEL")
  );

  if (old) return;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("start_onboarding")
      .setLabel("Start Onboarding")
      .setEmoji("🌎")
      .setStyle(ButtonStyle.Primary)
  );

  await channel.send({
    content:
      "**ASHEN_ONBOARDING_PANEL**\n\n" +
      "# 🖤 Welcome to Ashen Warriors\n\n" +
      "Choose your language first. The rest of onboarding will use that language.\n\n" +
      "You'll choose:\n" +
      "🌎 Language\n" +
      "🔔 Ping preferences\n" +
      "🎮 Playstyle\n" +
      "💬 Social preference",
    components: [row]
  });
}

// =====================================================
// MEMBER JOINS
// =====================================================

client.on(Events.GuildMemberAdd, async member => {
  if (member.user.bot) return;

  try {
    await member.roles.add(ASHEN_WARRIORS);

    console.log(
      `✅ Ashen Warriors added to ${member.user.tag}`
    );
  } catch (error) {
    console.error(
      "❌ Could not add Ashen Warriors:",
      error
    );
  }
});

// =====================================================
// PREFERENCE PANELS
// =====================================================

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
  const messages = await channel.messages.fetch({
    limit: 100
  });

  let message = messages.find(
    m =>
      m.author.id === client.user.id &&
      m.content.includes(marker)
  );

  if (!message) {
    message = await channel.send(text);
  }

  for (const emoji of emojis) {
    try {
      await message.react(emoji);
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
  const channel = await client.channels.fetch(
    CHANNELS.PREFERENCES
  );

  if (!channel?.isTextBased()) return;

  preferenceMessages.languages =
    await createPreferenceMessage(
      channel,
      "ASHEN_LANG_PREF",
      "**ASHEN_LANG_PREF**\n\n" +
      "# 🌎 Languages\n" +
      "React to every language you want access to.\n\n" +
      "🇺🇸 English\n" +
      "🇪🇸 Spanish\n" +
      "🇫🇷 French\n" +
      "🇩🇪 German\n" +
      "🇵🇹 Portuguese\n" +
      "🇯🇵 Japanese",
      Object.values(LANGUAGES).map(x => x.emoji)
    );

  preferenceMessages.reminders =
    await createPreferenceMessage(
      channel,
      "ASHEN_REMINDER_PREF",
      "**ASHEN_REMINDER_PREF**\n\n" +
      "# 🔔 Ping Preferences\n" +
      "React to every reminder you want.\n\n" +
      "🔄 Reset\n" +
      "🌅 Morning Conquest\n" +
      "🌌 Night Conquest\n" +
      "🔔 Clash Opening Call\n" +
      "⚔️ Clash Battle Call\n" +
      "🚨 Clash Final Call\n" +
      "⏰ Guild Clash Registration",
      Object.values(REMINDERS).map(x => x.emoji)
    );

  preferenceMessages.playstyle =
    await createPreferenceMessage(
      channel,
      "ASHEN_PLAYSTYLE_PREF",
      "**ASHEN_PLAYSTYLE_PREF**\n\n" +
      "# 🎮 Playstyle\n" +
      "Choose one.\n\n" +
      "🌿 Casual\n" +
      "⚔️ Competitive\n" +
      "🎮 Both",
      Object.values(PLAYSTYLE).map(x => x.emoji)
    );

  preferenceMessages.social =
    await createPreferenceMessage(
      channel,
      "ASHEN_SOCIAL_PREF",
      "**ASHEN_SOCIAL_PREF**\n\n" +
      "# 💬 Social Preference\n" +
      "Choose one.\n\n" +
      "💬 Chatty\n" +
      "🌙 Quiet\n" +
      "✨ Either",
      Object.values(SOCIAL).map(x => x.emoji)
    );

  console.log("✅ Preference panels ready.");
}

// =====================================================
// HELP CENTER
// =====================================================

async function setupHelpCenter() {
  const channel = await client.channels.fetch(
    CHANNELS.HELP
  );

  if (!channel?.isTextBased()) return;

  const messages = await channel.messages.fetch({
    limit: 50
  });

  const old = messages.find(
    m =>
      m.author.id === client.user.id &&
      m.content.includes("ASHEN_HELP_CENTER")
  );

  if (old) {
    console.log("✅ Help Center ready.");
    return;
  }

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

  await channel.send({
    content:
      "**ASHEN_HELP_CENTER**\n\n" +
      "# 🖤 Ashen Help Center\n\n" +
      "Need something? Choose an option below and PingBotLumi will point you in the right direction.\n\n" +
      "🎮 **Game Help** — Ask the community for game help\n" +
      "👥 **Need a Team** — Find people to play with\n" +
      "🛡️ **Ask Staff** — Privately contact Ashen staff\n" +
      "⚙️ **Discord Help** — Get help with the server or Discord\n" +
      "❓ **FAQ** — View common questions\n" +
      "🧭 **Server Guide** — Learn where everything is",
    components: [row1, row2]
  });

  console.log("✅ Help Center ready.");
}

// =====================================================
// HELP MODALS
// =====================================================

function createHelpModal(
  customId,
  title,
  label,
  placeholder
) {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title);

  const input = new TextInputBuilder()
    .setCustomId("help_details")
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(5)
    .setMaxLength(1000)
    .setRequired(true);

  const row =
    new ActionRowBuilder().addComponents(input);

  modal.addComponents(row);

  return modal;
}

// =====================================================
// HELP THREADS
// =====================================================

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

  if (!channel?.isTextBased()) {
    await interaction.reply({
      content:
        "❌ I couldn't access the help channel.",
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  const post = await channel.send({
    content:
      `${emoji} **${type}**\n\n` +
      `**From:** ${interaction.member}\n\n` +
      `${details}`
  });

  const safeName =
    `${type}-${interaction.user.username}`
      .replace(/[^a-zA-Z0-9-_]/g, "-")
      .slice(0, 90);

  const thread = await post.startThread({
    name: safeName,
    autoArchiveDuration: 1440
  });

  await thread.send({
    content:
      `${interaction.member}, your help thread is ready! 🖤\n\n` +
      "Anyone who can help is welcome to reply here."
  });

  await interaction.reply({
    content:
      `✅ Your request has been posted: ${thread}`,
    flags: MessageFlags.Ephemeral
  });
}

// =====================================================
// INTERACTIONS
// =====================================================

client.on(
  Events.InteractionCreate,
  async interaction => {
    try {

      // ===============================================
      // HELP BUTTONS
      // ===============================================

      if (
        interaction.isButton() &&
        interaction.customId === "help_game"
      ) {
        await interaction.showModal(
          createHelpModal(
            "modal_game_help",
            "Game Help",
            "What do you need help with?",
            "Explain what you're stuck on..."
          )
        );

        return;
      }

      if (
        interaction.isButton() &&
        interaction.customId === "help_team"
      ) {
        await interaction.showModal(
          createHelpModal(
            "modal_team_help",
            "Find a Team",
            "What are you looking for?",
            "Tell everyone what you need teammates for..."
          )
        );

        return;
      }

      if (
        interaction.isButton() &&
        interaction.customId === "help_staff"
      ) {
        await interaction.showModal(
          createHelpModal(
            "modal_staff_help",
            "Contact Ashen Staff",
            "What would you like staff to know?",
            "Explain your request or concern..."
          )
        );

        return;
      }

      if (
        interaction.isButton() &&
        interaction.customId === "help_discord"
      ) {
        await interaction.showModal(
          createHelpModal(
            "modal_discord_help",
            "Discord Help",
            "What do you need help with?",
            "Explain the Discord or server issue..."
          )
        );

        return;
      }

      if (
        interaction.isButton() &&
        interaction.customId === "help_faq"
      ) {
        await interaction.reply({
          content:
            "# ❓ Ashen FAQ\n\n" +

            "**🌎 How do I change my language roles?**\n" +
            `Use <#${CHANNELS.PREFERENCES}> and react to every language you want.\n\n` +

            "**🔔 How do I change reminder pings?**\n" +
            `Use <#${CHANNELS.PREFERENCES}> and react to the reminders you want.\n\n` +

            "**🎮 Can I change my playstyle or social role?**\n" +
            `Yes! Change them anytime in <#${CHANNELS.PREFERENCES}>.\n\n` +

            "**🌎 Can I speak more than one language?**\n" +
            "Yes! You can select multiple language roles.\n\n" +

            "**🛡️ How do I contact staff privately?**\n" +
            "Press **Ask Staff** in the Help Center.\n\n" +

            "**❓ What if my question isn't here?**\n" +
            "Use one of the Help Center options and we'll help you out! 🖤",

          flags: MessageFlags.Ephemeral
        });

        return;
      }

      if (
        interaction.isButton() &&
        interaction.customId === "help_guide"
      ) {
        await interaction.reply({
          content:
            "# 🧭 Ashen Server Guide\n\n" +

            `📍 <#${CHANNELS.START_HERE}>\n` +
            "Your starting point for the server.\n\n" +

            `📜 <#${CHANNELS.RULES}>\n` +
            "Read Ashen's community rules.\n\n" +

            `🌎 <#${CHANNELS.ONBOARDING}>\n` +
            "Complete or redo your Ashen onboarding.\n\n" +

            `🎭 <#${CHANNELS.PREFERENCES}>\n` +
            "Change your languages, reminders, playstyle, and social preference.\n\n" +

            `👋 <#${CHANNELS.INTRODUCTIONS}>\n` +
            "Meet new Ashen members.\n\n" +

            `🆘 <#${CHANNELS.HELP}>\n` +
            "Come back here whenever you need help.\n\n" +

            "🌎 **Language Channels**\n" +
            "Your language roles determine which translated chats you can access.",

          flags: MessageFlags.Ephemeral
        });

        return;
      }

      // ===============================================
      // HELP MODALS
      // ===============================================

      if (
        interaction.isModalSubmit() &&
        interaction.customId === "modal_game_help"
      ) {
        const details =
          interaction.fields.getTextInputValue(
            "help_details"
          );

        await createHelpThread(
          interaction,
          "Game Help",
          "🎮",
          details
        );

        return;
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId === "modal_team_help"
      ) {
        const details =
          interaction.fields.getTextInputValue(
            "help_details"
          );

        await createHelpThread(
          interaction,
          "Looking for a Team",
          "👥",
          details
        );

        return;
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId === "modal_discord_help"
      ) {
        const details =
          interaction.fields.getTextInputValue(
            "help_details"
          );

        await createHelpThread(
          interaction,
          "Discord Help",
          "⚙️",
          details
        );

        return;
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId === "modal_staff_help"
      ) {
        const details =
          interaction.fields.getTextInputValue(
            "help_details"
          );

        const staffChannel =
          await interaction.guild.channels.fetch(
            CHANNELS.STAFF_REQUESTS
          );

        if (!staffChannel?.isTextBased()) {
          await interaction.reply({
            content:
              "❌ I couldn't reach the staff request channel.",
            flags: MessageFlags.Ephemeral
          });

          return;
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
            roles: [
              STAFF_ROLES.LEADER,
              STAFF_ROLES.DEPUTY,
              STAFF_ROLES.OFFICERS
            ]
          }
        });

        await interaction.reply({
          content:
            "✅ Your message was sent privately to Ashen staff. A staff member can follow up with you.",
          flags: MessageFlags.Ephemeral
        });

        return;
      }

      // ===============================================
      // ONBOARDING
      // ===============================================

      if (
        interaction.isButton() &&
        interaction.customId === "start_onboarding"
      ) {
        sessions.set(interaction.user.id, {
          language: null,
          reminders: [],
          playstyle: null,
          social: null
        });

        await interaction.reply({
          content:
            "# 🌎 Choose your primary language\n\n" +
            "The rest of onboarding will automatically switch to your language.",

          components: [languageMenu()],
          flags: MessageFlags.Ephemeral
        });

        return;
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId === "onboard_language"
      ) {
        const language = interaction.values[0];

        const session =
          sessions.get(interaction.user.id) || {};

        session.language = language;
        session.reminders = [];
        session.playstyle = null;
        session.social = null;

        sessions.set(
          interaction.user.id,
          session
        );

        await interaction.update({
          content:
            `# ${TEXT[language].welcome}\n\n` +
            `## 🔔 ${TEXT[language].reminders}`,

          components: [
            reminderMenu(language)
          ]
        });

        return;
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId === "onboard_reminders"
      ) {
        const session =
          sessions.get(interaction.user.id);

        if (!session) return;

        session.reminders =
          interaction.values.includes("none")
            ? []
            : interaction.values.filter(
                x => x !== "none"
              );

        await interaction.update({
          content:
            `# 🎮 ${TEXT[session.language].playstyle}`,

          components: [
            playstyleMenu(session.language)
          ]
        });

        return;
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId === "onboard_playstyle"
      ) {
        const session =
          sessions.get(interaction.user.id);

        if (!session) return;

        session.playstyle =
          interaction.values[0] === "skip"
            ? null
            : interaction.values[0];

        await interaction.update({
          content:
            `# 💬 ${TEXT[session.language].social}`,

          components: [
            socialMenu(session.language)
          ]
        });

        return;
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId === "onboard_social"
      ) {
        const session =
          sessions.get(interaction.user.id);

        if (!session) return;

        session.social =
          interaction.values[0] === "skip"
            ? null
            : interaction.values[0];

        await interaction.update({
          content: "✅ Ready to finish!",
          components: [
            finishButton(session.language)
          ]
        });

        return;
      }

      if (
        interaction.isButton() &&
        interaction.customId === "onboard_finish"
      ) {
        await interaction.deferUpdate();

        const session =
          sessions.get(interaction.user.id);

        if (!session) {
          await interaction.editReply({
            content:
              "Your onboarding session expired. Please start again.",
            components: []
          });

          return;
        }

        const member =
          await interaction.guild.members.fetch(
            interaction.user.id
          );

        for (const roleId of RESETTABLE_ROLES) {
          if (PROTECTED_ROLES.has(roleId)) {
            continue;
          }

          if (member.roles.cache.has(roleId)) {
            try {
              await member.roles.remove(
                roleId
              );
            } catch (error) {
              console.error(
                `❌ Could not reset role ${roleId}:`,
                error.message
              );
            }
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
          const key of session.reminders
        ) {
          if (REMINDERS[key]) {
            await member.roles.add(
              REMINDERS[key].role
            );
          }
        }

        if (session.playstyle) {
          await member.roles.add(
            PLAYSTYLE[
              session.playstyle
            ].role
          );
        }

        if (session.social) {
          await member.roles.add(
            SOCIAL[
              session.social
            ].role
          );
        }

        await member.roles.add(
          ONBOARDING_COMPLETE
        );

        const intro =
          await interaction.guild.channels.fetch(
            CHANNELS.INTRODUCTIONS
          );

        if (intro?.isTextBased()) {
          const languageName =
            LANGUAGES[
              session.language
            ].name;

          const playstyleName =
            session.playstyle
              ? PLAYSTYLE[
                  session.playstyle
                ].name
              : "Not specified";

          const socialName =
            session.social
              ? SOCIAL[
                  session.social
                ].name
              : "Not specified";

          await intro.send(
            `# 🖤 Welcome ${member}!\n\n` +
            `🌎 **Language:** ${languageName}\n` +
            `🎮 **Playstyle:** ${playstyleName}\n` +
            `💬 **Social:** ${socialName}\n\n` +
            `Welcome to Ashen Warriors!`
          );
        }

        sessions.delete(
          interaction.user.id
        );

        await interaction.editReply({
          content:
            `# ✅ ${TEXT[session.language].done}`,
          components: []
        });

        return;
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
            flags: MessageFlags.Ephemeral
          });
        }
      } catch {}
    }
  }
);

// =====================================================
// REACTION ROLE HELPERS
// =====================================================

function itemByEmoji(group, emoji) {
  return Object.values(group).find(
    x => x.emoji === emoji
  );
}

async function reactionRole(
  reaction,
  user,
  adding
) {
  if (user.bot) return;

  if (reaction.partial) {
    await reaction.fetch();
  }

  const message =
    reaction.message;

  if (!message.guild) return;

  const member =
    await message.guild.members.fetch(
      user.id
    );

  const emoji =
    reaction.emoji.name;

  if (
    message.id ===
    preferenceMessages.languages?.id
  ) {
    const item =
      itemByEmoji(
        LANGUAGES,
        emoji
      );

    if (!item) return;

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
    preferenceMessages.reminders?.id
  ) {
    const item =
      itemByEmoji(
        REMINDERS,
        emoji
      );

    if (!item) return;

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
    preferenceMessages.playstyle?.id
  ) {
    const item =
      itemByEmoji(
        PLAYSTYLE,
        emoji
      );

    if (!item) return;

    if (adding) {
      for (
        const other of
        Object.values(PLAYSTYLE)
      ) {
        if (
          other.role !== item.role &&
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
    preferenceMessages.social?.id
  ) {
    const item =
      itemByEmoji(
        SOCIAL,
        emoji
      );

    if (!item) return;

    if (adding) {
      for (
        const other of
        Object.values(SOCIAL)
      ) {
        if (
          other.role !== item.role &&
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

client.on(
  Events.MessageReactionAdd,
  async (
    reaction,
    user
  ) => {
    try {
      await reactionRole(
        reaction,
        user,
        true
      );
    } catch (error) {
      console.error(
        "❌ Reaction add error:",
        error
      );
    }
  }
);

client.on(
  Events.MessageReactionRemove,
  async (
    reaction,
    user
  ) => {
    try {
      await reactionRole(
        reaction,
        user,
        false
      );
    } catch (error) {
      console.error(
        "❌ Reaction remove error:",
        error
      );
    }
  }
);

// =====================================================
// MYMEMORY TRANSLATOR
// =====================================================

async function translateText(
  text,
  source,
  target
) {
  const params =
    new URLSearchParams({
      q: text,
      langpair: `${source}|${target}`
    });

  const url =
    `https://api.mymemory.translated.net/get?${params.toString()}`;

  console.log(
    `🌐 MyMemory ${source} → ${target}`
  );

  const response =
    await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      signal:
        AbortSignal.timeout(
          15000
        )
    });

  if (!response.ok) {
    throw new Error(
      `MyMemory HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  const translatedText =
    data?.responseData
      ?.translatedText;

  if (
    !translatedText ||
    typeof translatedText !==
      "string"
  ) {
    throw new Error(
      "MyMemory returned no translation"
    );
  }

  if (
    data.responseStatus &&
    data.responseStatus !== 200
  ) {
    throw new Error(
      data.responseDetails ||
      `MyMemory status ${data.responseStatus}`
    );
  }

  return translatedText;
}

// =====================================================
// TRANSLATION WEBHOOKS
// =====================================================

const translationWebhooks =
  new Map();

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
          "PingBotLumi Translator"
    );

  if (!webhook) {
    webhook =
      await channel.createWebhook({
        name:
          "PingBotLumi Translator"
      });
  }

  translationWebhooks.set(
    channel.id,
    webhook
  );

  return webhook;
}

// =====================================================
// DISCORD TEXT LIMIT
// =====================================================

function limitDiscordText(
  text,
  max = 1900
) {
  if (!text) return "";

  if (text.length <= max) {
    return text;
  }

  return (
    text.slice(
      0,
      max - 3
    ) + "..."
  );
}

// =====================================================
// MULTILINGUAL MIRROR CHAT
// =====================================================

client.on(
  Events.MessageCreate,
  async message => {
    try {
      if (message.author.bot) {
        return;
      }

      if (message.webhookId) {
        return;
      }

      if (!message.guild) {
        return;
      }

      const sourceEntry =
        Object.entries(
          LANGUAGE_CHANNELS
        ).find(
          ([, info]) =>
            info.channel ===
            message.channel.id
        );

      if (!sourceEntry) {
        return;
      }

      const [
        sourceKey,
        sourceInfo
      ] = sourceEntry;

      const messageText =
        message.content.trim();

      const attachmentURLs =
        [
          ...message.attachments.values()
        ].map(
          attachment =>
            attachment.url
        );

      if (
        !messageText &&
        attachmentURLs.length === 0
      ) {
        return;
      }

      console.log(
        `🌎 New ${sourceInfo.name} message from ${message.author.username}`
      );

      const displayName =
        message.member?.displayName ||
        message.author.globalName ||
        message.author.username;

      const avatarURL =
        message.author
          .displayAvatarURL({
            extension: "png",
            size: 256
          });

      for (
        const [
          targetKey,
          targetInfo
        ] of Object.entries(
          LANGUAGE_CHANNELS
        )
      ) {
        if (
          targetKey === sourceKey
        ) {
          continue;
        }

        try {
          const targetChannel =
            await client.channels.fetch(
              targetInfo.channel
            );

          if (
            !targetChannel?.isTextBased()
          ) {
            console.error(
              `❌ ${targetInfo.name} channel unavailable.`
            );

            continue;
          }

          let translatedText = "";

          if (messageText) {
            translatedText =
              await translateText(
                messageText,
                sourceInfo.code,
                targetInfo.code
              );
          }

          let finalContent =
            translatedText;

          if (
            attachmentURLs.length >
            0
          ) {
            const attachmentText =
              attachmentURLs
                .map(
                  url =>
                    `📎 ${url}`
                )
                .join("\n");

            finalContent +=
              `${
                finalContent
                  ? "\n\n"
                  : ""
              }${attachmentText}`;
          }

          finalContent =
            limitDiscordText(
              finalContent
            );

          if (!finalContent) {
            continue;
          }

          const webhook =
            await getTranslationWebhook(
              targetChannel
            );

          await webhook.send({
            content:
              finalContent,

            username:
              `${displayName} • ${sourceInfo.emoji}`,

            avatarURL,

            allowedMentions: {
              parse: []
            }
          });

          console.log(
            `✅ Translation ${sourceInfo.name} → ${targetInfo.name}: ${displayName}`
          );

        } catch (error) {
          console.error(
            `❌ Translation ${sourceInfo.name} → ${targetInfo.name}: ${error.message}`
          );
        }
      }

    } catch (error) {
      console.error(
        "❌ Translation listener error:",
        error
      );
    }
  }
);

// =====================================================
// AUTOMATIC REMINDER PINGS
// =====================================================

async function ping(
  role,
  text
) {
  try {
    const channel =
      await client.channels.fetch(
        CHANNELS.REMINDERS
      );

    if (!channel?.isTextBased()) {
      return;
    }

    await channel.send({
      content:
        `<@&${role}> ${text}`,

      allowedMentions: {
        roles: [role]
      }
    });

    console.log(
      `✅ Reminder sent: ${text}`
    );

  } catch (error) {
    console.error(
      "❌ Reminder error:",
      error
    );
  }
}

const TZ =
  "America/Chicago";

// DAILY

cron.schedule(
  "0 8 * * *",
  () =>
    ping(
      REMINDERS.reset.role,
      "🔄 Reset reminder!"
    ),
  {
    timezone: TZ
  }
);

cron.schedule(
  "30 11 * * *",
  () =>
    ping(
      REMINDERS.morning.role,
      "🌅 Morning Conquest reminder!"
    ),
  {
    timezone: TZ
  }
);

cron.schedule(
  "30 20 * * *",
  () =>
    ping(
      REMINDERS.night.role,
      "🌌 Night Conquest reminder!"
    ),
  {
    timezone: TZ
  }
);

// MONDAY / WEDNESDAY / FRIDAY

cron.schedule(
  "0 10 * * 1,3,5",
  () =>
    ping(
      REMINDERS.opening.role,
      "🔔 Clash Opening Call!"
    ),
  {
    timezone: TZ
  }
);

cron.schedule(
  "0 16 * * 1,3,5",
  () =>
    ping(
      REMINDERS.battle.role,
      "⚔️ Clash Battle Call!"
    ),
  {
    timezone: TZ
  }
);

cron.schedule(
  "30 21 * * 1,3,5",
  () =>
    ping(
      REMINDERS.final.role,
      "🚨 Clash Final Call!"
    ),
  {
    timezone: TZ
  }
);

// SUNDAY / TUESDAY / THURSDAY

cron.schedule(
  "30 9 * * 0,2,4",
  () =>
    ping(
      REMINDERS.registration.role,
      "⏰ Guild Clash Registration reminder!"
    ),
  {
    timezone: TZ
  }
);

// =====================================================
// READY
// =====================================================

client.once(
  Events.ClientReady,
  async readyClient => {
    console.log(
      `✅ PingBotLumi online as ${readyClient.user.tag}`
    );

    try {
      await setupOnboardingPanel();

      console.log(
        "✅ Onboarding panel ready."
      );
    } catch (error) {
      console.error(
        "❌ Onboarding panel error:",
        error
      );
    }

    try {
      await setupPreferences();
    } catch (error) {
      console.error(
        "❌ Preferences error:",
        error
      );
    }

    try {
      await setupHelpCenter();
    } catch (error) {
      console.error(
        "❌ Help Center error:",
        error
      );
    }

    console.log(
      "✅ MyMemory multilingual translation system active."
    );

    console.log(
      "✅ All recurring schedules are active."
    );
  }
);

// =====================================================
// LOGIN
// =====================================================

client.login(
  process.env.DISCORD_BOT
);