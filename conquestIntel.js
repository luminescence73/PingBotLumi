import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType,
  EmbedBuilder, MessageFlags, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle
} from "discord.js";
import { readFile } from "node:fs/promises";

// ASHEN CONQUEST INTEL — existing channel and hand-curated names preserved.
// The guild floor is a bot-tracked counter (not a game API reading).
// Only staff-confirmed boss defeats advance it. No daily scouting forms.
const ENEMIES_URL = "https://www.purrwikimania.com/enemies";
const COMBAT_URL = "https://www.purrwikimania.com/combat";
const CHANNEL_KEY = "ashen_conquest_intel_channel_v1";
const PANEL_KEY = "ashen_conquest_intel_panel_v1";
const SOURCE_KEY = "ashen_conquest_intel_source_check_v2";
const FIRST_KNOWN_FLOOR = 136; // Nov 9 screenshot, not a live game connection
const REFRESH_MS = 6 * 60 * 60 * 1000;
const MAX_FLOOR = 5000;

let context = null;
let ticker = null;
let checkInProgress = false;
let pendingRenders = Promise.resolve();

const normalize = value => String(value || "")
  .normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "");
const short = (value, max = 500) => String(value || "").slice(0, max);

async function readState(key) {
  const rows = await context.pool.query("SELECT value FROM bot_state WHERE key = $1", [key]);
  return rows.rows[0]?.value || null;
}
async function writeState(key, value) {
  await context.pool.query(
    "INSERT INTO bot_state(key,value,updated_at) VALUES($1,$2::jsonb,NOW()) " +
    "ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
    [key, JSON.stringify(value)]
  );
}
function guild() {
  return context?.guild || context?.client?.guilds?.cache?.first() || null;
}
async function setupTables() {
  await context.pool.query(
    "CREATE TABLE IF NOT EXISTS conquest_intel_progress (" +
    "guild_id TEXT PRIMARY KEY, floor INTEGER NOT NULL CHECK (floor BETWEEN 1 AND 5000), " +
    "last_from INTEGER, last_to INTEGER, last_action TEXT, updated_by TEXT, " +
    "updated_at TIMESTAMPTZ DEFAULT NOW())"
  );
  await context.pool.query(
    "CREATE TABLE IF NOT EXISTS conquest_intel_clear_history (" +
    "guild_id TEXT NOT NULL, floor INTEGER NOT NULL, cleared_by TEXT, " +
    "cleared_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (guild_id, floor))"
  );
  await context.pool.query(
    "INSERT INTO conquest_intel_progress (guild_id, floor) VALUES ($1, $2) " +
    "ON CONFLICT (guild_id) DO NOTHING",
    [guild().id, FIRST_KNOWN_FLOOR]
  );
}
async function getProgress() {
  const result = await context.pool.query(
    "SELECT floor, last_from, last_to, last_action, updated_by, updated_at " +
    "FROM conquest_intel_progress WHERE guild_id = $1",
    [guild().id]
  );
  return result.rows[0] || { floor: FIRST_KNOWN_FLOOR };
}
async function getChannel() {
  const server = guild();
  if (!server) return null;
  const previous = await readState(CHANNEL_KEY);
  if (previous?.channelId) {
    const channel = await server.channels.fetch(previous.channelId).catch(() => null);
    if (channel?.type === ChannelType.GuildText) return channel;
    // Respect staff-curated names, IDs, and previous manual cleanup.
    console.warn("⚠️ Conquest Intel: saved channel ID unavailable. No replacement will be created.");
    return null;
  }
  await server.channels.fetch();
  const intel = server.channels.cache.find(channel =>
    channel.type === ChannelType.GuildCategory &&
    normalize(channel.name).includes("swordxstaffintel")
  );
  if (!intel) return null;
  const existing = server.channels.cache.find(channel =>
    channel.type === ChannelType.GuildText &&
    channel.parentId === intel.id &&
    normalize(channel.name) === "conquestintel"
  );
  if (existing) {
    await writeState(CHANNEL_KEY, { channelId: existing.id, created: true });
  }
  // Older setup already created the channel. Never create or rename more.
  return existing || null;
}
async function checkSource() {
  const previous = (await readState(SOURCE_KEY)) || {};
  const result = { ...previous, checkedAt: new Date().toISOString(), healthy: false };
  try {
    const response = await fetch(ENEMIES_URL, {
      signal: AbortSignal.timeout(12000),
      headers: { Accept: "text/html", "User-Agent": "Vestra-Conquest-Intel/2.0" }
    });
    result.statusCode = response.status;
    if (response.ok) {
      const html = await response.text();
      if (/Guild Conquest/i.test(html) && /Enemies/i.test(html)) {
        result.healthy = true;
        result.lastHealthyAt = result.checkedAt;
      }
    }
  } catch (error) {
    result.statusCode = null;
    console.warn("⚠️ Conquest source status:", error.message);
  }
  await writeState(SOURCE_KEY, result);
  return result;
}
function checkedAt(source) {
  const stamp = Date.parse(source?.checkedAt || "");
  return Number.isFinite(stamp)
    ? "<t:" + Math.floor(stamp / 1000) + ":R>"
    : "not checked yet";
}
function sourceLabel(source) {
  if (source?.healthy) return "Online · checked " + checkedAt(source);
  if (source?.lastHealthyAt) return "Latest check failed · last verified previously";
  return "Availability unconfirmed";
}

// F136 screenshot-confirmed data. Exact boss numbers are from the player's
// in-game Monster Stats screen (not from the public website's HTML).
// This entry is preserved when the guild advances to a new floor.
const BOSS_DATA = Object.freeze({
  136: Object.freeze({
    name: "Spider Queen",
    artwork: { filename: "spider-queen-f136.webp", asset: "./assets/conquest/spider-queen-f136.webp.b64" },
    level: 346,
    rank: "Master",
    stats: Object.freeze({
      hp: "346B",
      atk: "13.9M",
      def: "14M",
      spd: "6.68M",
      resilience: "240",
      critRate: "60.1%",
      critDamage: "50%",
      critResistance: "32.2%",
      blockRate: "53%",
      blockEfficiency: "100%",
      accuracy: "27.2%",
      damageBoost: "45.5%",
      damageResistance: "43.8%",
      healingBoost: "0%",
      effectHitRate: "114K",
      effectResistance: "114K",
      elementalMastery: "143K",
      elementalResistance: "143K",
      physicalMastery: "143K",
      physicalResistance: "143K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 14.4K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 14.4K each"
    }),
    skillLabels: Object.freeze(["Drag", "Ailment", "DMG", "Summon"]),
    note: "Captured from in-game Conquest F136 boss and Monster Stats screenshots."
  })
});

function knownBoss(floor) {
  return BOSS_DATA[Number(floor)] || null;
}

// Display compact decision-useful Intel; every stat is also accessible through
// the Detailed Stats button, without requiring a staff input or daily update.
function bossFields(floor) {
  const boss = knownBoss(floor);
  if (boss) {
    const st = boss.stats;
    return [
      {
        name: "🕷️ BOSS IDENTIFICATION",
        value: "**" + boss.name + "** • Level **" + boss.level +
          "** • **" + boss.rank + "** rank\n" +
          "Confirmed directly in-game at F" + floor + "."
      },
      {
        name: "📊 CORE STATS",
        value: "❤️ **HP:** " + st.hp + "  •  ⚔️ **ATK:** " + st.atk +
          "\n🛡️ **DEF:** " + st.def + "  •  💨 **SPD:** " + st.spd +
          "\n**Resilience:** " + st.resilience
      },
      {
        name: "🛡️ DEFENSIVE STRENGTHS",
        value: "**Block Rate:** " + st.blockRate +
          " • **Block Efficiency:** " + st.blockEfficiency +
          "\n**DMG RES:** " + st.damageResistance +
          " • **Crit RES:** " + st.critResistance +
          "\nHer high block chance and damage resistance can make attacks less effective."
      },
      {
        name: "⚡ OFFENSIVE STRENGTHS",
        value: "**Crit Rate:** " + st.critRate +
          " • **Crit DMG:** " + st.critDamage +
          "\n**DMG Boost:** " + st.damageBoost +
          " • **Accuracy:** " + st.accuracy +
          "\nPrepare for damaging attacks and potential critical hits."
      },
      {
        name: "🌀 VISIBLE SKILL TYPES",
        value: "**Drag • Ailment • DMG • Summon**\n" +
          "These are the labels shown under the four skill icons. " +
          "Check their in-game descriptions for exact ranges, triggers, " +
          "status effects, and summon behavior."
      },
      {
        name: "🎯 WEAKNESSES / ELEMENTAL INTEL",
        value: "**No specific elemental weakness confirmed.**\n" +
          "All five Affinities and Aegis values are **14.4K each** " +
          "(Wind, Water, Fire, Light, Dark). These equal displayed values " +
          "don't identify a preferred damage element."
      },
      {
        name: "📋 TACTICAL PRIORITIES",
        value: "• **Survivability:** Mind the 60.1% Crit Rate and Drag/Ailment skill types.\n" +
          "• **Damage:** High Block Rate and DMG RES may blunt your attacks.\n" +
          "• **Summons:** Check when the Summon skill activates; plan for extra targets if it creates adds.\n" +
          "• **Rank gap:** This Master boss may sharply punish lower-ranked attackers.\n" +
          "• **Second run:** Compare survival and damage before swapping skills."
      }
    ];
  }
  return [
    {
      name: "🐉 BOSS / IDENTIFICATION",
      value: "**Name, level and rank not yet verified for F" + floor + ".**"
    },
    {
      name: "📊 LEVEL • RANK",
      value: "Not yet confirmed for this floor. Check the Guild Conquest floor view in the enemy database."
    },
    {
      name: "⚡ STRENGTHS",
      value: "Check enemy rank, damage resistance, block rate, critical stats and skill triggers."
    },
    {
      name: "🎯 WEAKNESSES",
      value: "No specific elemental vulnerability confirmed. Do not assume appearance indicates damage type."
    },
    {
      name: "🛡️ COMBAT INTEL",
      value: "• Rank scaling strongly affects the damage dealt and received.\n" +
        "• Inspect boss skill icons for counters and status effects.\n" +
        "• Coordinate tanks, support, and damage for each attempt."
    }
  ];
}

function statBreakdownEmbed(floor) {
  const boss = knownBoss(floor);
  if (!boss) {
    return new EmbedBuilder()
      .setColor(0x4D5366)
      .setTitle("📊 F" + floor + " — Monster Stats")
      .setDescription("Exact stats are not verified for this floor. " +
        "Browse **Guild Conquest** at " + ENEMIES_URL + " for the in-game enemy reference.");
  }
  const st = boss.stats;
  return new EmbedBuilder()
    .setColor(0x8176CE)
    .setTitle("🕷️ F" + floor + " • " + boss.name + " — Full Monster Stats")
    .setDescription("**Master rank • Level 346**\n" +
      "Source: member-provided in-game Monster Stats screenshots.")
    .addFields(
      { name: "⚔️ Main stats", value:
        "**ATK:** " + st.atk + "\n**DEF:** " + st.def +
        "\n**HP:** " + st.hp + "\n**SPD:** " + st.spd },
      { name: "🛡️ Defense / survival", value:
        "**Resilience:** " + st.resilience +
        "\n**Crit RES:** " + st.critResistance +
        "\n**Block Rate:** " + st.blockRate +
        "\n**Block Efficiency:** " + st.blockEfficiency +
        "\n**DMG RES:** " + st.damageResistance +
        "\n**Healing Boost:** " + st.healingBoost },
      { name: "⚡ Offense / accuracy", value:
        "**Crit Rate:** " + st.critRate +
        "\n**Crit DMG:** " + st.critDamage +
        "\n**Accuracy:** " + st.accuracy +
        "\n**DMG Boost:** " + st.damageBoost +
        "\n**Effect Hit Rate:** " + st.effectHitRate },
      { name: "🧬 Resistances / mastery", value:
        "**Effect RES:** " + st.effectResistance +
        "\n**Elemental Mastery:** " + st.elementalMastery +
        "\n**Elemental RES:** " + st.elementalResistance +
        "\n**Physical Mastery:** " + st.physicalMastery +
        "\n**Physical RES:** " + st.physicalResistance },
      { name: "🌈 Elemental affinities", value: st.elementalAffinities },
      { name: "🔰 Elemental aegis", value: st.elementalAegis },
      { name: "🌀 Skill labels", value: boss.skillLabels.join(" • ") +
        "\nExact effects aren't shown in the supplied screenshots." }
    ).setFooter({ text: "Screenshot-confirmed F136 record • This does not update live boss HP." });
}

function progressBar(floor) {
  // Floor progression indicator; NOT a boss-HP bar.
  const prev = Math.max(1, floor - 1);
  const next = Math.min(MAX_FLOOR, floor + 1);
  return "✅ F" + prev + "   ━━━━━   ⚔️ **F" + floor + "**   ━━━━━   ⏭️ F" + next;
}
function mainEmbed(progress, source, includeArtwork = false) {
  const floor = Number(progress.floor);
  const boss = knownBoss(floor);
  const st = boss?.stats;
  const title = boss
    ? "🕷️ CONQUEST INTEL  |  F" + floor + " • " + boss.name
    : "⚔️ CONQUEST INTEL  |  FLOOR " + floor;
  const embed = new EmbedBuilder()
    .setColor(0x8176CE)
    .setTitle(title)
    .setDescription(boss
      ? "**MASTER • LV. " + boss.level + "**\n" +
        "❤️ HP " + st.hp + "   •   ⚔️ ATK " + st.atk + "\n" +
        "🛡️ DEF " + st.def + "   •   💨 SPD " + st.spd + "\n\n" +
        "**⚠️ Key threats**\n" +
        "Block " + st.blockRate + "  •  DMG RES " + st.damageResistance +
        "  •  Crit " + st.critRate + "\n" +
        "Skills: **" + boss.skillLabels.join(" · ") + "**\n\n" +
        "**🎯 Weakness & approach**\n" +
        "Elemental weakness unconfirmed (all five Affinity/Aegis values: 14.4K). " +
        "Protect against critical hits and check Drag, Ailment and Summon skill effects."
      : "**Boss identity and level not yet verified.**\n" +
        "Use the game-data reference to inspect the next floor's actual skills, defenses and rank.\n\n" +
        "**🛡️ Preparation:** Check counters, rank differences, and team survivability."
    )
    .addFields({
      name: "📍 PROGRESSION",
      value: "**F" + floor + "**  →  **F" + Math.min(MAX_FLOOR, floor + 1) +
        "** next  •  Staff use **Boss Down** after a clear."
    })
    .setFooter({
      text: boss
        ? "F136 boss: in-game screenshots • Floor tracked by Vestra"
        : "Floor tracked by Vestra • Boss data not verified"
    });
  if (includeArtwork && boss?.artwork) {
    embed.setImage("attachment://" + boss.artwork.filename);
  }
  return embed;
}

function nextEmbed(floor, source) {
  return new EmbedBuilder()
    .setColor(0x4D5366)
    .setTitle("📖 UPCOMING CONQUEST | F" + (floor + 1) + "–F" + (floor + 5))
    .setDescription(
      Array.from({ length: 5 }, (_, index) => {
        const f = floor + index + 1;
        const boss = knownBoss(f);
        return "**Floor " + f + "** — " + (boss
          ? boss.name + " • Lv. " + boss.level + " • " + boss.rank
          : "boss/level not verified");
      }).join("\n") + "\n\n" +
      "🔎 **Boss names, exact levels, skills and resistances:** " + ENEMIES_URL +
      "\n\n**Automated source check:** " + sourceLabel(source) + "\n" +
      "*The floor numbers advance with your guild's Boss Down confirmations.*"
    );
}
function rows() {
  // Two visible buttons total. Other actions move into one private menu.
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("cintel_down")
        .setLabel("Boss Down")
        .setEmoji("☠️")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("cintel_more")
        .setLabel("More Options")
        .setEmoji("📖")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}
function optionsMenu(staff) {
  const options = [
    { label: "Detailed Monster Stats", value: "stats", emoji: "📊", description: "All saved stats for the current boss" },
    { label: "Skills & Strategy", value: "tactics", emoji: "🛡️", description: "Threats, weaknesses and combat notes" },
    { label: "Upcoming Bosses", value: "upcoming", emoji: "⏭️", description: "Preview the next five floors" },
    { label: "Find a Floor", value: "lookup", emoji: "🔎", description: "Look up a specific Conquest floor" }
  ];
  if (staff) {
    options.push(
      { label: "Undo Last Clear", value: "undo", emoji: "↩️", description: "Staff: reverse the previous Boss Down" },
      { label: "Correct Current Floor", value: "correct", emoji: "🧭", description: "Staff: synchronize with the in-game floor" }
    );
  }
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("cintel_options_select")
      .setPlaceholder("Choose what to view or manage")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options)
  );
}
// Embed artwork is decoded from a small tracked base64 asset and attached
// directly to Discord. No external CDN or staff uploads are necessary.
async function artworkAttachment(floor) {
  const asset = knownBoss(floor)?.artwork;
  if (!asset) return null;
  try {
    const encoded = (await readFile(new URL(asset.asset, import.meta.url), "utf8")).trim();
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length < 1000 || bytes.toString("ascii", 0, 4) !== "RIFF") {
      throw new Error("Image data is invalid");
    }
    return new AttachmentBuilder(bytes, { name: asset.filename });
  } catch (error) {
    console.warn("⚠️ Conquest Intel boss artwork unavailable:", error.message);
    return null;
  }
}
function payload(progress, source, artwork = null) {
  return {
    content: "",
    embeds: [mainEmbed(progress, source, Boolean(artwork))],
    components: rows(),
    files: artwork ? [artwork] : [],
    // Do not accumulate stale attachments when advancing or refreshing.
    attachments: [],
    allowedMentions: { parse: [] }
  };
}

async function editPanel() {
  const channel = await getChannel();
  if (!channel) return null;
  const progress = await getProgress();
  const source = await readState(SOURCE_KEY);
  const artwork = await artworkAttachment(progress.floor);
  const previous = await readState(PANEL_KEY);
  let message = previous?.channelId === channel.id && previous?.messageId
    ? await channel.messages.fetch(previous.messageId).catch(() => null)
    : null;
  if (!message) {
    const recent = await channel.messages.fetch({ limit: 60 }).catch(() => null);
    message = recent?.find(item => item.author?.id === context.client.user.id &&
      (item.content?.startsWith("# ASHEN / CONQUEST INTEL") ||
       item.embeds?.[0]?.title?.includes("CONQUEST INTEL"))) || null;
  }

  const data = payload(progress, source, artwork);
  if (message) {
    // Replace the previous image rather than accumulating attachments.
    await message.edit(data);
  } else {
    // New messages need the file upload but no retained-attachments field.
    delete data.attachments;
    message = await channel.send(data);
  }
  await writeState(PANEL_KEY, { channelId: channel.id, messageId: message.id });
  if (!message.pinned) await message.pin().catch(() => {});
  return message;
}
function updatePanel() {
  // Serial editing prevents older requests from overwriting newer floor cards.
  pendingRenders = pendingRenders.catch(() => {}).then(() => editPanel());
  return pendingRenders;
}
async function refreshSourceAndPanel() {
  if (checkInProgress) return;
  checkInProgress = true;
  try {
    await checkSource();
    await updatePanel();
  } catch (error) {
    console.error("❌ Conquest Intel refresh:", error);
  } finally {
    checkInProgress = false;
  }
}
export async function setupConquestIntel({ client, pool, guild: server }) {
  context = { client, pool, guild: server };
  const channel = await getChannel();
  if (!channel) {
    console.warn("⚠️ Existing Conquest Intel channel not found; preserving all channel names.");
    return null;
  }
  await setupTables();
  await refreshSourceAndPanel();
  if (ticker) clearInterval(ticker);
  ticker = setInterval(() => { void refreshSourceAndPanel(); }, REFRESH_MS);
  return channel;
}
function parseFloor(value) {
  const raw = String(value || "").trim();
  if (!/^\d{1,4}$/.test(raw)) return null;
  const floor = Number(raw);
  return floor >= 1 && floor <= MAX_FLOOR ? floor : null;
}
function floorModal(floor) {
  return new ModalBuilder()
    .setCustomId("cintel_floor_submit")
    .setTitle("Correct Conquest Floor")
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("floor").setLabel("Current Conquest floor (one-time correction)")
        .setStyle(TextInputStyle.Short).setValue(String(floor))
        .setMinLength(1).setMaxLength(4).setRequired(true)
    ));
}
function lookupModal(floor) {
  return new ModalBuilder()
    .setCustomId("cintel_lookup_submit").setTitle("Look Up Conquest Floor")
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("floor").setLabel("Floor number")
        .setStyle(TextInputStyle.Short).setValue(String(floor))
        .setMinLength(1).setMaxLength(4).setRequired(true)
    ));
}
async function staffAccess(interaction, isStaff) {
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  return !!member && (isStaff(member) || interaction.guild.ownerId === interaction.user.id);
}
async function showFloor(interaction, floor) {
  const progress = { floor };
  const source = await readState(SOURCE_KEY);
  const artwork = await artworkAttachment(floor);
  await interaction.reply({
    embeds: [mainEmbed(progress, source, Boolean(artwork))],
    files: artwork ? [artwork] : [],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] }
  });
}
async function tryClearBoss(interaction, confirmedFloor) {
  const sql =
    "UPDATE conquest_intel_progress SET floor = floor + 1, " +
    "last_from = floor, last_to = floor + 1, last_action = 'down', " +
    "updated_by = $3, updated_at = NOW() " +
    "WHERE guild_id = $1 AND floor = $2 AND floor < $4 RETURNING floor";
  const update = await context.pool.query(sql, [
    interaction.guild.id, confirmedFloor, interaction.user.id, MAX_FLOOR
  ]);
  if (!update.rowCount) return null;
  await context.pool.query(
    "INSERT INTO conquest_intel_clear_history (guild_id, floor, cleared_by) " +
    "VALUES ($1,$2,$3) ON CONFLICT (guild_id,floor) " +
    "DO UPDATE SET cleared_by=EXCLUDED.cleared_by, cleared_at=NOW()",
    [interaction.guild.id, confirmedFloor, interaction.user.id]
  );
  return update.rows[0].floor;
}
async function tryUndo(interaction, confirmedFloor) {
  const update = await context.pool.query(
    "UPDATE conquest_intel_progress SET floor=last_from, " +
    "last_action='undo', updated_by=$3, updated_at=NOW() " +
    "WHERE guild_id=$1 AND floor=$2 AND last_action='down' " +
    "AND last_to=$2 AND last_from IS NOT NULL RETURNING floor",
    [interaction.guild.id, confirmedFloor, interaction.user.id]
  );
  if (!update.rowCount) return null;
  await context.pool.query(
    "DELETE FROM conquest_intel_clear_history WHERE guild_id=$1 AND floor=$2",
    [interaction.guild.id, update.rows[0].floor]
  );
  return update.rows[0].floor;
}
function confirmRow(action, floor) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("cintel_confirm_" + action + "_" + floor)
      .setLabel(action === "down" ? "Confirm Boss Defeated" : "Confirm Undo")
      .setStyle(action === "down" ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("cintel_cancel")
      .setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );
}
export async function handleConquestIntelInteraction(interaction, { client, pool, isStaff }) {
  const id = interaction.customId || "";
  if (!id.startsWith("cintel_")) return false;
  context = { ...(context || {}), client, pool, guild: interaction.guild };

  if (id === "cintel_cancel" && interaction.isButton()) {
    await interaction.update({ content: "Cancelled. Nothing changed.", components: [] });
    return true;
  }
  // Legacy staff report forms from earlier deployments are retired.
  if (["cintel_report", "cintel_report_submit", "cintel_set_floor_submit"].includes(id)) {
    await interaction.reply({
      content: "Reports are retired. Boss Down advances floors; no daily reports are needed.",
      flags: MessageFlags.Ephemeral
    });
    return true;
  }
  if (interaction.isStringSelectMenu() && id === "cintel_options_select") {
    const selection = interaction.values[0];
    const current = await getProgress();
    const floor = Number(current.floor);
    if (selection === "stats") {
      await interaction.update({
        content: "📊 **Detailed Monster Stats • F" + floor + "**",
        embeds: [statBreakdownEmbed(floor)],
        components: []
      });
      return true;
    }
    if (selection === "tactics") {
      await interaction.update({
        content: "🛡️ **Skills & Strategy • F" + floor + "**",
        embeds: [new EmbedBuilder()
          .setColor(0x8176CE)
          .setTitle("⚔️ Conquest Boss Intel • F" + floor)
          .addFields(...bossFields(floor))],
        components: []
      });
      return true;
    }
    if (selection === "upcoming") {
      await interaction.update({
        content: "⏭️ **Upcoming Conquest Bosses**",
        embeds: [nextEmbed(floor, await readState(SOURCE_KEY))],
        components: []
      });
      return true;
    }
    if (selection === "lookup") {
      await interaction.showModal(lookupModal(floor));
      return true;
    }
    if (selection === "undo" || selection === "correct") {
      if (!await staffAccess(interaction, isStaff)) {
        await interaction.update({
          content: "Only Ashen staff can change Conquest progress.",
          embeds: [],
          components: []
        });
        return true;
      }
      if (selection === "correct") {
        await interaction.showModal(floorModal(floor));
        return true;
      }
      if (current.last_action !== "down" || Number(current.last_to) !== floor) {
        await interaction.update({
          content: "There is no most recent Boss Down action to undo.",
          embeds: [],
          components: []
        });
      } else {
        await interaction.update({
          content: "↩️ Undo the last clear? Return from **F" + floor +
            "** to **F" + current.last_from + "**?",
          embeds: [],
          components: [confirmRow("undo", floor)]
        });
      }
      return true;
    }
    await interaction.update({ content: "This option is unavailable.", components: [] });
    return true;
  }
  if (!interaction.isButton() && !interaction.isModalSubmit()) return false;
  const privateReply = text => interaction.reply({
    content: text, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] }
  });

  if (interaction.isButton()) {
    if (id === "cintel_more") {
      const staff = await staffAccess(interaction, isStaff);
      await interaction.reply({
        content: "📖 **Conquest Intel** — choose a view:",
        components: [optionsMenu(staff)],
        flags: MessageFlags.Ephemeral
      });
      return true;
    }
    if (id === "cintel_stats") {
      const current = await getProgress();
      await interaction.reply({
        embeds: [statBreakdownEmbed(Number(current.floor))],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] }
      });
      return true;
    }
    if (id === "cintel_current" || id === "cintel_reference") {
      const current = await getProgress();
      await showFloor(interaction, Number(current.floor));
      return true;
    }
    if (id === "cintel_next" || id === "cintel_upcoming") {
      const current = await getProgress();
      const floor = Number(current.floor);
      const source = await readState(SOURCE_KEY);
      await interaction.reply({
        embeds: [nextEmbed(floor, source)],
        flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] }
      });
      return true;
    }
    if (id === "cintel_lookup") {
      const current = await getProgress();
      await interaction.showModal(lookupModal(current.floor));
      return true;
    }
    if (id === "cintel_down" || id === "cintel_undo" || id === "cintel_set_floor") {
      if (!await staffAccess(interaction, isStaff)) {
        await privateReply("Only Ashen staff can change the guild's Conquest floor.");
        return true;
      }
      const current = await getProgress();
      if (id === "cintel_set_floor") {
        await interaction.showModal(floorModal(current.floor));
      } else if (id === "cintel_down") {
        if (Number(current.floor) >= MAX_FLOOR) {
          await privateReply("Maximum supported floor reached.");
        } else {
          await interaction.reply({
            content: "⚔️ Confirm the guild defeated **Floor " + current.floor +
              "**. This will advance Conquest Intel to **F" + (Number(current.floor) + 1) + "**.",
            components: [confirmRow("down", Number(current.floor))],
            flags: MessageFlags.Ephemeral
          });
        }
      } else if (current.last_action !== "down" || Number(current.last_to) !== Number(current.floor)) {
        await privateReply("There is no most recent Boss Down action to undo.");
      } else {
        await interaction.reply({
          content: "↩️ Undo the last cleared boss? The tracker will return from **F" +
            current.floor + "** to **F" + current.last_from + "**.",
          components: [confirmRow("undo", Number(current.floor))],
          flags: MessageFlags.Ephemeral
        });
      }
      return true;
    }

    const confirmation = id.match(/^cintel_confirm_(down|undo)_(\d{1,4})$/);
    if (confirmation) {
      if (!await staffAccess(interaction, isStaff)) {
        await privateReply("Only Ashen staff can confirm Conquest progress.");
        return true;
      }
      const base = parseFloor(confirmation[2]);
      if (!base) {
        await privateReply("Invalid floor.");
        return true;
      }
      await interaction.deferUpdate();
      const newFloor = confirmation[1] === "down"
        ? await tryClearBoss(interaction, base)
        : await tryUndo(interaction, base);
      if (newFloor === null) {
        await interaction.editReply({
          content: "⚠️ Conquest floor changed since this confirmation appeared, or the action is no longer valid. Open the panel again.",
          components: []
        });
      } else {
        await updatePanel();
        await interaction.editReply({
          content: (confirmation[1] === "down" ? "✅ Boss defeated!" : "↩️ Last clear undone.") +
            " Conquest Intel is now on **Floor " + newFloor + "**.",
          components: []
        });
      }
      return true;
    }
  }

  if (interaction.isModalSubmit()) {
    if (id === "cintel_lookup_submit") {
      const floor = parseFloor(interaction.fields.getTextInputValue("floor"));
      if (floor) await showFloor(interaction, floor);
      else await privateReply("Enter a valid floor number from 1 to 5000.");
      return true;
    }

    if (id === "cintel_floor_submit") {
      if (!await staffAccess(interaction, isStaff)) {
        await privateReply("Only Ashen staff can correct the tracked floor.");
        return true;
      }
      const floor = parseFloor(interaction.fields.getTextInputValue("floor"));
      if (!floor) {
        await privateReply("Enter a valid floor number from 1 to 5000.");
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await pool.query(
        "UPDATE conquest_intel_progress SET floor=$2, last_from=NULL, " +
        "last_to=NULL, last_action='correct', updated_by=$3, updated_at=NOW() " +
        "WHERE guild_id=$1",
        [interaction.guild.id, floor, interaction.user.id]
      );
      await updatePanel();
      await interaction.editReply("🧭 Conquest Intel corrected to **Floor " + floor +
        "**. Future Boss Down presses will advance from here.");
      return true;
    }
  }

  await privateReply("This is an outdated Conquest Intel control. Use the updated panel.");
  return true;
}
