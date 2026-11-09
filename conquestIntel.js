import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";

// The channel now takes NO daily or staff-entered information.
// Purrwikimania publishes the live, interactive Guild Conquest enemy table,
// and Vestra checks the source automatically. The website does not expose
// a verified machine-readable floor endpoint, so never invent floor stats.
const ENEMIES_URL = "https://www.purrwikimania.com/enemies";
const COMBAT_URL = "https://www.purrwikimania.com/combat";
const RANK_URL = "https://www.purrwikimania.com/combat/ranks";
const CHANNEL_KEY = "ashen_conquest_intel_channel_v1";
const PANEL_KEY = "ashen_conquest_intel_panel_v1";
const SOURCE_KEY = "ashen_conquest_intel_source_check_v2";
const REFERENCE_FLOOR = 136; // user screenshot on Nov 9, NOT live guild progress
const UPDATE_PERIOD_MS = 6 * 60 * 60 * 1000;
let context = null;
let timer = null;
let busy = false;

const key = value => String(value || "").normalize("NFKC")
  .toLowerCase().replace(/[^a-z0-9]+/g, "");

async function readState(stateKey) {
  const result = await context.pool.query(
    "SELECT value FROM bot_state WHERE key = $1", [stateKey]
  );
  return result.rows[0]?.value || null;
}

async function saveState(stateKey, value) {
  await context.pool.query(
    "INSERT INTO bot_state(key,value,updated_at) VALUES($1,$2::jsonb,NOW()) " +
    "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
    [stateKey, JSON.stringify(value)]
  );
}

function findIntelCategory(guild) {
  return guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildCategory &&
    key(channel.name).includes("swordxstaffintel")
  ) || null;
}

async function getIntelChannel({ create = false } = {}) {
  const guild = context.guild || context.client.guilds.cache.first();
  if (!guild) return null;
  await guild.channels.fetch();

  const existingState = await readState(CHANNEL_KEY);
  if (existingState?.channelId) {
    const linked = guild.channels.cache.get(existingState.channelId);
    if (linked?.type === ChannelType.GuildText) return linked;
    console.warn("⚠️ Conquest Intel: previously saved channel missing; no replacement will be created.");
    return null;
  }

  const category = findIntelCategory(guild);
  if (!category) {
    console.warn("⚠️ Conquest Intel: existing SxS Intel category unavailable.");
    return null;
  }
  const existing = guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildText &&
    channel.parentId === category.id &&
    key(channel.name) === "conquestintel"
  );
  if (existing) {
    await saveState(CHANNEL_KEY, { channelId: existing.id, created: true });
    return existing;
  }

  // Only the already-authorized original channel creation. This is not
  // a repeating channel creator and does not change staff-curated names.
  if (!create || existingState?.created) return null;
  const channel = await guild.channels.create({
    name: "conquest-intel",
    type: ChannelType.GuildText,
    parent: category.id,
    topic: "Automatically refreshed Guild Conquest enemy references and strategy. No manual updates.",
    reason: "Ashen requested an automatically maintained Conquest Intel reference channel"
  });
  await saveState(CHANNEL_KEY, { channelId: channel.id, created: true });
  await channel.lockPermissions().catch(error =>
    console.warn("⚠️ Conquest Intel access sync failed:", error.message)
  );
  return channel;
}

async function checkReferenceSource() {
  const previous = (await readState(SOURCE_KEY)) || {};
  const result = { ...previous, checkedAt: new Date().toISOString(), healthy: false };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetch(ENEMIES_URL, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "Accept": "text/html",
          "User-Agent": "Ashen-Vestra-Conquest-Intel/1.0"
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      const html = await response.text();
      // Check that this is truly the game enemy page, not an error page.
      if (/Guild Conquest/i.test(html) && /enemies/i.test(html)) {
        result.healthy = true;
        result.lastHealthyAt = result.checkedAt;
      }
    }
    result.statusCode = response.status;
  } catch (error) {
    result.statusCode = null;
    console.warn("⚠️ Conquest Intel source was not reachable:", error.message);
  }
  await saveState(SOURCE_KEY, result);
  return result;
}

function discordTimestamp(iso) {
  const epoch = Date.parse(iso || "");
  return Number.isFinite(epoch) ? "<t:" + Math.floor(epoch / 1000) + ":R>" : "not yet verified";
}

function panelText(sourceStatus) {
  const sourceHealth = sourceStatus?.healthy
    ? "✅ Reference website available • checked " + discordTimestamp(sourceStatus.checkedAt)
    : sourceStatus?.lastHealthyAt
      ? "⚠️ Latest check failed • last reachable " + discordTimestamp(sourceStatus.lastHealthyAt)
      : "⚠️ Reference connection not yet verified — existing links still work for members";

  return [
    "# ASHEN / CONQUEST INTEL",
    "**AUTOMATIC SOURCE GUIDE · NO STAFF MAINTENANCE REQUIRED**",
    "",
    "## ⚔️ Conquest Boss Database",
    "Browse **Guild Conquest** in the full game-data enemy reference:",
    ENEMIES_URL,
    "",
    "It provides the game's enemy listings, skills and rank-based statistics for Conquest floors. ",
    "The reference is maintained externally; Vestra checks whether it remains available every 6 hours.",
    "**Reference status:** " + sourceHealth,
    "",
    "## 📍 Floor 136 and Upcoming Floors",
    "Your **November 9 screenshot** showed Floor **136**, a purple armored creature and **52% HP** at that moment.",
    "That is a snapshot, **not a live reading**. Your guild may be farther ahead now.",
    "To check **F136, F137, F138 and later floors**, open the database, select **Guild Conquest**, and choose the floor number.",
    "Vestra doesn't have a connection to Sword X Staff's private guild progress, so it won't guess your current floor.",
    "",
    "## 🛡️ What matters when fighting these bosses",
    "• **Rank difference:** The damage multiplier depends strongly on the difference between your rank and the enemy's rank.",
    "• **Boss skills:** Check the database for each boss's actual attacks and counter skills before adjusting your build.",
    "• **Large boss positioning:** Don't stack every melee character in limited adjacent squares; maintain room for tanks and ranged damage.",
    "• **Counterattack risk:** If a boss has a reactive counter skill, high-frequency attackers may need stronger defensive mitigation.",
    "• **Second run:** Use what you learned in the first battle to adjust positioning and survival; no manual data entry is required.",
    "",
    "**Useful combat formulas:** " + COMBAT_URL,
    "",
    "*Exact boss identities and numbers aren't copied into this panel until a verified machine-readable source exists. The linked database is the authoritative interactive floor lookup.*"
  ].join("\n");
}

function controls() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Browse Conquest Bosses")
        .setStyle(ButtonStyle.Link)
        .setEmoji("⚔️")
        .setURL(ENEMIES_URL),
      new ButtonBuilder()
        .setLabel("Combat Formulas")
        .setStyle(ButtonStyle.Link)
        .setEmoji("📊")
        .setURL(COMBAT_URL),
      new ButtonBuilder()
        .setLabel("Floor Lookup")
        .setStyle(ButtonStyle.Secondary)
        .setCustomId("cintel_lookup")
        .setEmoji("🔎")
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Floor 136 Guide")
        .setStyle(ButtonStyle.Secondary)
        .setCustomId("cintel_reference"),
      new ButtonBuilder()
        .setLabel("Future Bosses")
        .setStyle(ButtonStyle.Secondary)
        .setCustomId("cintel_upcoming")
    )
  ];
}

async function updatePanel(sourceStatus) {
  const channel = await getIntelChannel();
  if (!channel) return;
  const saved = await readState(PANEL_KEY);
  let message = saved?.channelId === channel.id && saved?.messageId
    ? await channel.messages.fetch(saved.messageId).catch(() => null)
    : null;

  if (!message) {
    const recent = await channel.messages.fetch({ limit: 60 }).catch(() => null);
    message = recent?.find(m => m.author?.id === context.client.user.id &&
      m.content?.startsWith("# ASHEN / CONQUEST INTEL")) || null;
  }

  const payload = {
    content: panelText(sourceStatus),
    components: controls(),
    embeds: [],
    allowedMentions: { parse: [] }
  };
  if (message) await message.edit(payload);
  else message = await channel.send(payload);

  await saveState(PANEL_KEY, { channelId: channel.id, messageId: message.id });
  if (!message.pinned) await message.pin().catch(() => {});
}

async function refreshSourceAndPanel() {
  if (busy) return;
  busy = true;
  try {
    const status = await checkReferenceSource();
    await updatePanel(status);
    console.log("✅ Conquest Intel source checked and panel refreshed.");
  } catch (error) {
    console.error("❌ Conquest Intel refresh:", error);
  } finally {
    busy = false;
  }
}

export async function setupConquestIntel({ client, pool, guild }) {
  context = { client, pool, guild };
  const channel = await getIntelChannel({ create: true });
  if (!channel) return null;

  await refreshSourceAndPanel();
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    void refreshSourceAndPanel();
  }, UPDATE_PERIOD_MS);
  return channel;
}

function floorNumber(raw) {
  if (!/^[0-9]{1,4}$/.test(String(raw || "").trim())) return null;
  const n = Number(raw);
  return n >= 1 && n <= 5000 ? n : null;
}

function floorSummary(floor) {
  const screenshot = floor === REFERENCE_FLOOR
    ? "\n\n**Known screenshot (November 9):** purple armored boss, 52% HP at capture. This is not live status."
    : "";
  return new EmbedBuilder()
    .setTitle("⚔️ Guild Conquest F" + floor)
    .setColor(0x363B41)
    .setDescription(
      "Open **" + ENEMIES_URL + "**, select **Guild Conquest**, then enter **Floor " +
      floor + "** for its enemy, stats and skills.\n\n" +
      "Vestra cannot safely extract that interactive table into Discord yet, and will not make up a boss name or abilities." +
      screenshot
    )
    .addFields({
      name: "Combat preparation",
      value: "Compare ranks and review the boss's counters, range, damage type and defensive skills before each run."
    })
    .setFooter({ text: "Automatic reference • No staff updates required" });
}

export async function handleConquestIntelInteraction(interaction, { client, pool }) {
  const id = interaction.customId || "";
  if (!id.startsWith("cintel_")) return false;
  context = { ...(context || {}), client, pool, guild: interaction.guild };

  // Old modals and staff controls may survive in Discord from the previous
  // deployment. Explicitly retire them rather than accepting new reports.
  if (id === "cintel_report" || id === "cintel_set_floor" ||
      id === "cintel_floor_submit" || id === "cintel_report_submit") {
    await interaction.reply({
      content: "Conquest Intel now updates automatically. There are no staff forms or daily maintenance steps.",
      flags: MessageFlags.Ephemeral
    });
    return true;
  }

  if (interaction.isButton()) {
    if (id === "cintel_lookup") {
      const modal = new ModalBuilder()
        .setTitle("Find a Conquest Floor")
        .setCustomId("cintel_lookup_submit");
      const field = new TextInputBuilder()
        .setCustomId("floor")
        .setLabel("Floor number from the game")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("136")
        .setValue("136")
        .setMaxLength(4)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(field));
      await interaction.showModal(modal);
      return true;
    }
    if (id === "cintel_reference") {
      await interaction.reply({
        embeds: [floorSummary(REFERENCE_FLOOR)],
        flags: MessageFlags.Ephemeral
      });
      return true;
    }
    if (id === "cintel_current") {
      await interaction.reply({
        content: "The guild's floor cannot be read automatically from the game. " +
          "Floor 136 was your last screenshot, not a live status. " +
          "Use **Floor Lookup** to check a specific floor at " + ENEMIES_URL,
        flags: MessageFlags.Ephemeral
      });
      return true;
    }
    if (id === "cintel_upcoming") {
      await interaction.reply({
        content: "## 📚 Guild Conquest Floors 136–150\n\n" +
          Array.from({ length: 15 }, (_, i) => "**F" + (136 + i) + "**").join(" · ") +
          "\n\nBrowse their **actual** boss names, skills and stats by selecting **Guild Conquest** and the floor number:\n" +
          ENEMIES_URL +
          "\n\n*These aren't predictions of the guild's current progress.*",
        flags: MessageFlags.Ephemeral
      });
      return true;
    }
  }

  if (interaction.isModalSubmit() && id === "cintel_lookup_submit") {
    const floor = floorNumber(interaction.fields.getTextInputValue("floor"));
    if (!floor) {
      await interaction.reply({
        content: "Enter a valid number from 1 to 5000.",
        flags: MessageFlags.Ephemeral
      });
      return true;
    }
    await interaction.reply({
      embeds: [floorSummary(floor)],
      flags: MessageFlags.Ephemeral
    });
    return true;
  }

  await interaction.reply({
    content: "This Conquest Intel control was retired. Please use the updated panel.",
    flags: MessageFlags.Ephemeral
  });
  return true;
}
