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

// One staff-curated reference channel. No background guesses about enemy
// names, hidden stats or mechanics: entries exist only when staff report them.
// Names/layout remain under staff control after the initial requested creation.
const CHANNEL_STATE = "ashen_conquest_intel_channel_v1";
const CURRENT_STATE = "ashen_conquest_intel_current_floor_v1";
const PANEL_STATE = "ashen_conquest_intel_panel_v1";
const FLOOR_AT_SCREENSHOT = 136;
const REFERENCE = "https://www.purrwikimania.com/enemies";
let ctx = null;

const norm = value => String(value || "")
  .normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "");

function trimmed(value, max = 900) {
  return String(value || "").trim().slice(0, max);
}

async function state(key) {
  const response = await ctx.pool.query("SELECT value FROM bot_state WHERE key = $1", [key]);
  return response.rows[0]?.value || null;
}

async function saveState(key, value) {
  await ctx.pool.query(
    "INSERT INTO bot_state(key, value, updated_at) VALUES($1, $2::jsonb, NOW()) " +
    "ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
    [key, JSON.stringify(value)]
  );
}

async function initRecords() {
  await ctx.pool.query(
    "CREATE TABLE IF NOT EXISTS conquest_intel_records (" +
    "floor INTEGER PRIMARY KEY, " +
    "boss_name TEXT, rank_notes TEXT, mechanics TEXT, tactics TEXT, " +
    "submitted_by TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())"
  );
}

async function currentFloor() {
  const data = await state(CURRENT_STATE);
  const floor = Number(data?.floor);
  return Number.isInteger(floor) && floor >= 1 && floor <= 5000
    ? floor : FLOOR_AT_SCREENSHOT;
}

async function recordFor(floor) {
  const result = await ctx.pool.query(
    "SELECT floor, boss_name, rank_notes, mechanics, tactics, submitted_by, updated_at " +
    "FROM conquest_intel_records WHERE floor = $1", [floor]
  );
  return result.rows[0] || null;
}

async function recordsForRange(start, end) {
  const result = await ctx.pool.query(
    "SELECT floor, boss_name, rank_notes, mechanics, tactics, submitted_by, updated_at " +
    "FROM conquest_intel_records WHERE floor BETWEEN $1 AND $2 ORDER BY floor",
    [start, end]
  );
  return new Map(result.rows.map(row => [Number(row.floor), row]));
}

async function resolveChannel({ create = false } = {}) {
  const guild = ctx.guild || ctx.client.guilds.cache.first();
  if (!guild) throw new Error("Ashen Warriors guild is unavailable.");
  await guild.channels.fetch();

  const category = guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildCategory &&
    norm(channel.name).includes("swordxstaffintel")
  );
  if (!category) {
    console.warn("⚠️ Conquest Intel: Sword X Staff | Intel category not found; no channel created.");
    return null;
  }

  const saved = await state(CHANNEL_STATE);
  if (saved?.channelId) {
    const fixed = guild.channels.cache.get(saved.channelId);
    if (fixed?.type === ChannelType.GuildText) return fixed;
    console.warn("⚠️ Conquest Intel: saved channel is missing. Staff must approve replacement.");
    return null;
  }

  const existing = guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildText &&
    channel.parentId === category.id &&
    norm(channel.name) === "conquestintel"
  );
  if (existing) {
    await saveState(CHANNEL_STATE, { channelId: existing.id, created: true });
    return existing;
  }

  if (!create || saved?.created) return null;

  // User explicitly requested a new Conquest Intel channel. Create it ONCE.
  const channel = await guild.channels.create({
    name: "conquest-intel",
    type: ChannelType.GuildText,
    parent: category.id,
    topic: "Ashen Warriors Conquest boss scouting, floor guides and staff-confirmed strategies.",
    reason: "Requested Conquest Intel channel under the existing SxS Intel category"
  });
  await saveState(CHANNEL_STATE, { channelId: channel.id, created: true });
  await channel.lockPermissions().catch(error =>
    console.warn("⚠️ Conquest Intel permission sync:", error.message)
  );
  console.log("✅ Conquest Intel channel created:", channel.id);
  return channel;
}

function profile(floor, row) {
  const title = row?.boss_name
    ? "⚔️ Floor " + floor + " — " + row.boss_name
    : "⚔️ Floor " + floor + " — Awaiting identification";
  const embed = new EmbedBuilder()
    .setTitle(title.slice(0, 250))
    .setColor(0x363B41)
    .setDescription(
      "Conquest scouting profile • " +
      (row ? "**Staff-reported intel** (not independently verified)" :
      "**Not yet verified** — no boss abilities or elements have been confirmed here.")
    )
    .addFields(
      { name: "Rank / Elements / Weaknesses", value: trimmed(row?.rank_notes, 1000) || "Awaiting scouting.", inline: false },
      { name: "Skills / Counterattacks", value: trimmed(row?.mechanics, 1000) || "Awaiting scouting. Tap the boss skill icons in-game and check for counterattacks.", inline: false },
      { name: "Recommended Approach", value: trimmed(row?.tactics, 1000) || "Check rank difference, boss skills, team survival, and your damage per attempt before changing builds.", inline: false }
    )
    .setFooter({ text: row
      ? "Staff report by " + row.submitted_by + " • Recheck after game patches"
      : "Add findings through Staff: Record Intel • No guessed abilities"
    });
  if (floor === FLOOR_AT_SCREENSHOT) {
    embed.addFields({
      name: "Last screenshot — November 9, 2026",
      value: "Ashen was on Floor 136, with 52% HP showing. The pictured boss is a purple armored, horned creature. This is a historical screenshot, not a live HP feed."
    });
  }
  return embed;
}

function panelContent(floor, rows) {
  const current = rows.get(floor);
  const next = [];
  for (let value = floor + 1; value <= floor + 6; value++) {
    const reported = rows.get(value);
    next.push("• **F" + value + "** — " +
      (reported?.boss_name ? trimmed(reported.boss_name, 75) + " (staff report)" : "Not yet identified"));
  }

  return [
    "# ASHEN / CONQUEST INTEL",
    "**CURRENT GUILD FLOOR • F" + floor + "**",
    current?.boss_name
      ? "Boss: **" + trimmed(current.boss_name, 100) + "** — staff-reported"
      : "Boss: **Awaiting verified identification**",
    floor === FLOOR_AT_SCREENSHOT
      ? "📷 Nov 9 screenshot: **52% HP** at the time of capture. This is **not live HP**."
      : "Boss HP and daily attempts must be checked in-game.",
    "",
    "**UPCOMING BOSSES**",
    ...next,
    "",
    "**BATTLE CHECKLIST**",
    "1. Tap the boss's skill icons to check counterattacks and damage type.",
    "2. Compare enemy rank to your party's rank; rank gaps strongly affect damage.",
    "3. Record effective counters, positioning, and first-run versus second-run results.",
    "4. Staff can update the current floor and boss reports using the controls below.",
    "",
    "🔎 Detailed floor stats and skills: " + REFERENCE,
    "*Only verified source details and clearly labeled staff reports appear here.*"
  ].join("\n");
}

function panelButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("cintel_current").setLabel("Current Boss").setEmoji("⚔️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("cintel_upcoming").setLabel("Upcoming Floors").setEmoji("📖").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("cintel_lookup").setLabel("Find Floor").setEmoji("🔎").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("cintel_report").setLabel("Staff: Record Intel").setEmoji("📝").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("cintel_set_floor").setLabel("Staff: Set Floor").setEmoji("📍").setStyle(ButtonStyle.Secondary)
    )
  ];
}

async function updatePanel() {
  const channel = await resolveChannel();
  if (!channel) return null;
  const floor = await currentFloor();
  const rows = await recordsForRange(floor, Math.min(5000, floor + 6));
  const payload = {
    content: panelContent(floor, rows),
    components: panelButtons(),
    allowedMentions: { parse: [] }
  };
  const saved = await state(PANEL_STATE);
  let panel = saved?.channelId === channel.id && saved.messageId
    ? await channel.messages.fetch(saved.messageId).catch(() => null)
    : null;

  if (!panel) {
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    panel = recent?.find(message =>
      message.author?.id === ctx.client.user.id &&
      message.content?.startsWith("# ASHEN / CONQUEST INTEL")
    ) || null;
  }
  if (panel) await panel.edit(payload);
  else panel = await channel.send(payload);
  await saveState(PANEL_STATE, { channelId: channel.id, messageId: panel.id });
  await panel.pin().catch(() => {});
  return panel;
}

export async function setupConquestIntel({ client, pool, guild }) {
  ctx = { client, pool, guild };
  await initRecords();
  const channel = await resolveChannel({ create: true });
  if (!channel) return null;
  await updatePanel();
  return channel;
}

function floorModal(id, title, defaultFloor) {
  const modal = new ModalBuilder().setCustomId(id).setTitle(title);
  const entry = new TextInputBuilder()
    .setCustomId("floor")
    .setLabel("Conquest floor number")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(4)
    .setValue(String(defaultFloor));
  modal.addComponents(new ActionRowBuilder().addComponents(entry));
  return modal;
}

function reportModal(floor, existing) {
  const modal = floorModal("cintel_report_submit", "Record Conquest Boss Intel", floor);
  const inputs = [
    { key: "boss", label: "Boss name (if confirmed)", max: 100, value: existing?.boss_name },
    { key: "rank", label: "Rank, element, resistance, weakness", max: 750, value: existing?.rank_notes },
    { key: "skills", label: "Observed skills and counterattacks", max: 950, value: existing?.mechanics },
    { key: "tactics", label: "Working tactics / team setup", max: 950, value: existing?.tactics }
  ];
  for (const item of inputs) {
    const entry = new TextInputBuilder()
      .setCustomId(item.key)
      .setLabel(item.label)
      .setStyle(item.max <= 100 ? TextInputStyle.Short : TextInputStyle.Paragraph)
      .setMaxLength(item.max)
      .setRequired(false);
    if (item.value) entry.setValue(trimmed(item.value, item.max));
    modal.addComponents(new ActionRowBuilder().addComponents(entry));
  }
  return modal;
}

function validateFloor(raw) {
  if (!/^[0-9]{1,4}$/.test(String(raw || "").trim())) return null;
  const floor = Number(raw);
  return Number.isInteger(floor) && floor >= 1 && floor <= 5000 ? floor : null;
}

async function staffAllowed(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  return !!member && ctx.isStaff(member);
}

async function replyFloor(interaction, floor) {
  const row = await recordFor(floor);
  return interaction.reply({
    embeds: [profile(floor, row)],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] }
  });
}

// Returns true if this was a Conquest Intel component.
export async function handleConquestIntelInteraction(interaction, { client, pool, isStaff }) {
  const id = interaction.customId || "";
  if (!id.startsWith("cintel_")) return false;
  ctx = { ...(ctx || {}), client, pool, isStaff, guild: interaction.guild };

  if (interaction.isButton()) {
    if (id === "cintel_current") {
      await replyFloor(interaction, await currentFloor());
      return true;
    }
    if (id === "cintel_upcoming") {
      const floor = await currentFloor();
      const rows = await recordsForRange(floor + 1, Math.min(floor + 12, 5000));
      const lines = [];
      for (let i = floor + 1; i <= Math.min(floor + 12, 5000); i++) {
        const row = rows.get(i);
        lines.push("**F" + i + "** — " + (row?.boss_name
          ? trimmed(row.boss_name, 80) + " (staff-reported)" : "Boss not verified yet"));
      }
      await interaction.reply({
        content: "## 📖 Upcoming Conquest Bosses\n\n" + lines.join("\n") +
          "\n\nSearch floor-specific stats: " + REFERENCE +
          "\n\n*Unknown names and mechanics are deliberately not guessed.*",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] }
      });
      return true;
    }
    if (id === "cintel_lookup") {
      await interaction.showModal(floorModal("cintel_lookup_submit", "Look Up Conquest Floor", await currentFloor()));
      return true;
    }
    if (id === "cintel_report") {
      if (!await staffAllowed(interaction)) {
        await interaction.reply({ content: "Only Ashen staff can submit boss intel.", flags: MessageFlags.Ephemeral });
        return true;
      }
      const floor = await currentFloor();
      await interaction.showModal(reportModal(floor, await recordFor(floor)));
      return true;
    }
    if (id === "cintel_set_floor") {
      if (!await staffAllowed(interaction)) {
        await interaction.reply({ content: "Only Ashen staff can change the current floor.", flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.showModal(floorModal("cintel_floor_submit", "Set Current Conquest Floor", await currentFloor()));
      return true;
    }
  }

  if (interaction.isModalSubmit()) {
    const floor = validateFloor(interaction.fields.getTextInputValue("floor"));
    if (!floor) {
      await interaction.reply({ content: "Enter a valid floor from 1 to 5000.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (id === "cintel_lookup_submit") {
      await replyFloor(interaction, floor);
      return true;
    }
    if (id === "cintel_floor_submit" || id === "cintel_report_submit") {
      if (!await staffAllowed(interaction)) {
        await interaction.reply({ content: "Only Ashen staff can change Conquest intel.", flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (id === "cintel_floor_submit") {
        await saveState(CURRENT_STATE, { floor, updatedBy: interaction.user.id });
      } else {
        const get = key => trimmed(interaction.fields.getTextInputValue(key));
        await pool.query(
          "INSERT INTO conquest_intel_records (floor, boss_name, rank_notes, mechanics, tactics, submitted_by, updated_at) " +
          "VALUES ($1, $2, $3, $4, $5, $6, NOW()) " +
          "ON CONFLICT (floor) DO UPDATE SET boss_name = EXCLUDED.boss_name, " +
          "rank_notes = EXCLUDED.rank_notes, mechanics = EXCLUDED.mechanics, " +
          "tactics = EXCLUDED.tactics, submitted_by = EXCLUDED.submitted_by, updated_at = NOW()",
          [floor, get("boss"), get("rank"), get("skills"), get("tactics"),
            interaction.member?.displayName || interaction.user.username]
        );
      }
      await updatePanel();
      await interaction.editReply(
        id === "cintel_floor_submit"
          ? "📍 Current Conquest floor set to **F" + floor + "**."
          : "📝 Staff Conquest Intel saved for **F" + floor + "**. The panel is updated."
      );
      return true;
    }
  }

  await interaction.reply({ content: "This Conquest Intel control is no longer supported.", flags: MessageFlags.Ephemeral });
  return true;
}
