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
    name: "Spider Queen", emoji: "🕷️",
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
    threats: "Drag, Ailment and Summon skill types are visible; confirm exact effects in-game.",
    note: "Captured from in-game Conquest F136 boss and Monster Stats screenshots."
  }),
  137: Object.freeze({
    name: "Cyclopean Geocrusher", emoji: "🪨",
    artwork: { filename: "cyclopean-geocrusher-f137.webp", asset: "./assets/conquest/cyclopean-geocrusher-f137.webp.b64" },
    level: 352, rank: "Master",
    stats: Object.freeze({
      hp: "359B", atk: "14.1M", def: "17.2M", spd: "4.6M",
      resilience: "240", critRate: "60.1%", critDamage: "50%",
      critResistance: "32.2%", blockRate: "53%", blockEfficiency: "100%",
      accuracy: "27.2%", damageBoost: "45.5%", damageResistance: "43.8%",
      healingBoost: "0%", effectHitRate: "120K", effectResistance: "120K",
      elementalMastery: "150K", elementalResistance: "150K",
      physicalMastery: "150K", physicalResistance: "150K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 14.5K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 14.5K each"
    }),
    skillLabels: Object.freeze(["DMG","Dispel","Counterattack","DMG"]),
    threats: "Counterattack and Dispel appear in the boss's skill list. Check their effects and triggers before using multi-hit attacks.",
    note: "Source: supplied game screenshots of F137; floor was locked."
  }),
  138: Object.freeze({
    name: "Bovine Titan", emoji: "🐂",
    artwork: { filename: "bovine-titan-f138.webp", asset: "./assets/conquest/bovine-titan-f138.webp.b64" },
    level: 358, rank: "Master",
    stats: Object.freeze({
      hp: "372B", atk: "14.5M", def: "17.3M", spd: "5.72M",
      resilience: "240", critRate: "60.1%", critDamage: "50%",
      critResistance: "32.2%", blockRate: "53%", blockEfficiency: "100%",
      accuracy: "27.2%", damageBoost: "45.5%", damageResistance: "43.8%",
      healingBoost: "0%", effectHitRate: "126K", effectResistance: "126K",
      elementalMastery: "158K", elementalResistance: "158K",
      physicalMastery: "158K", physicalResistance: "158K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 14.7K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 14.7K each"
    }),
    skillLabels: Object.freeze(["Debuff","DMG","DMG","Movement","Counterattack"]),
    threats: "Debuff, Movement and Counterattack appear in the boss's skill list. Check their effects, range and triggers before attacking.",
    note: "Source: supplied game screenshots of F138; floor was locked."
  }),
  139: Object.freeze({
    name: "Regal Cactus", emoji: "🌵",
    artwork: { filename: "regal-cactus-f139.webp", asset: "./assets/conquest/regal-cactus-f139.webp.b64" },
    level: 364, rank: "Master",
    stats: Object.freeze({
      hp: "385B", atk: "21.6M", def: "15.6M", spd: "8.73M",
      resilience: "240", critRate: "60.6%", critDamage: "50%",
      critResistance: "32.3%", blockRate: "53.1%", blockEfficiency: "100%",
      accuracy: "27.3%", damageBoost: "45.5%", damageResistance: "43.8%",
      healingBoost: "0%", effectHitRate: "132K", effectResistance: "132K",
      elementalMastery: "165K", elementalResistance: "165K",
      physicalMastery: "165K", physicalResistance: "165K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 14.9K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 14.9K each"
    }),
    skillLabels: Object.freeze(["DMG", "DMG", "DMG", "Buff"]),
    threats: "Three damage-type skills and one Buff skill are shown. With 21.6M ATK and 8.73M SPD, plan for heavy and relatively fast attacks; check what the Buff enhances.",
    note: "Source: supplied game screenshots of F139; floor was locked."
  }),
  140: Object.freeze({
    name: "Polyhedral Sun", emoji: "☀️",
    artwork: { filename: "polyhedral-sun-f140.webp", asset: "./assets/conquest/polyhedral-sun-f140.webp.b64" },
    level: 370, rank: "Master",
    stats: Object.freeze({
      hp: "399B", atk: "13.3M", def: "19.4M", spd: "6.83M",
      resilience: "240", critRate: "61%", critDamage: "100%",
      critResistance: "32.3%", blockRate: "53.1%", blockEfficiency: "100%",
      accuracy: "27.3%", damageBoost: "45.6%", damageResistance: "43.8%",
      healingBoost: "0%", effectHitRate: "139K", effectResistance: "139K",
      elementalMastery: "174K", elementalResistance: "174K",
      physicalMastery: "174K", physicalResistance: "174K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 15.1K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 15.1K each"
    }),
    skillLabels: Object.freeze(["DMG", "DMG", "Buff", "DMG"]),
    threats: "Three damage-type skills and a Buff skill are visible. Watch its 100% Crit DMG, 61% Crit Rate and 19.4M DEF; inspect the Buff's effect before adjusting your team's defenses.",
    note: "Source: supplied game screenshots of F140; floor was locked."
  }),
  141: Object.freeze({
    name: "Aqua Shaman", emoji: "🌊",
    artwork: { filename: "aqua-shaman-f141.webp", asset: "./assets/conquest/aqua-shaman-f141.webp.b64" },
    level: 376, rank: "Master",
    stats: Object.freeze({
      hp: "413B", atk: "15.6M", def: "18.7M", spd: "7.07M",
      resilience: "240", critRate: "61.1%", critDamage: "50%",
      critResistance: "32.3%", blockRate: "53.2%", blockEfficiency: "100%",
      accuracy: "27.3%", damageBoost: "45.6%", damageResistance: "43.8%",
      healingBoost: "0%", effectHitRate: "147K", effectResistance: "147K",
      elementalMastery: "184K", elementalResistance: "184K",
      physicalMastery: "184K", physicalResistance: "184K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 15.4K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 15.4K each"
    }),
    skillLabels: Object.freeze(["DMG","DMG","Dispel","DMG","Counter"]),
    threats: "Three DMG skills, Dispel and Counter are shown. Check what triggers the Counter skill before using multiple strikes, and watch for buff removal from Dispel.",
    note: "Source: user-provided screenshots; this Conquest floor was locked."
  }),
  142: Object.freeze({
    name: "Armored General", emoji: "⚔️",
    artwork: { filename: "armored-general-f142.webp", asset: "./assets/conquest/armored-general-f142.webp.b64" },
    level: 382, rank: "Master",
    stats: Object.freeze({
      hp: "429B", atk: "17.4M", def: "19.4M", spd: "7.7M",
      resilience: "240", critRate: "61.2%", critDamage: "50%",
      critResistance: "32.4%", blockRate: "53.3%", blockEfficiency: "100%",
      accuracy: "27.4%", damageBoost: "45.6%", damageResistance: "43.9%",
      healingBoost: "0%", effectHitRate: "155K", effectResistance: "155K",
      elementalMastery: "193K", elementalResistance: "193K",
      physicalMastery: "193K", physicalResistance: "193K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 15.6K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 15.6K each"
    }),
    skillLabels: Object.freeze(["DMG","DMG","DMG","Movement"]),
    threats: "Three DMG skills and Movement are visible. Watch for repositioning and keep fragile allies clear of possible attack paths. Exact ranges and triggers need confirmation.",
    note: "Source: user-provided screenshots; this Conquest floor was locked."
  }),
  143: Object.freeze({
    name: "Nine-Tailed Fox", emoji: "🦊",
    artwork: { filename: "nine-tailed-fox-f143.webp", asset: "./assets/conquest/nine-tailed-fox-f143.webp.b64" },
    level: 388, rank: "Master",
    stats: Object.freeze({
      hp: "444B", atk: "16.8M", def: "20.1M", spd: "7.6M",
      resilience: "240", critRate: "61.3%", critDamage: "50%",
      critResistance: "32.4%", blockRate: "53.4%", blockEfficiency: "100%",
      accuracy: "27.4%", damageBoost: "45.7%", damageResistance: "43.9%",
      healingBoost: "0%", effectHitRate: "163K", effectResistance: "163K",
      elementalMastery: "204K", elementalResistance: "204K",
      physicalMastery: "204K", physicalResistance: "204K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 15.9K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 15.9K each"
    }),
    skillLabels: Object.freeze(["DMG","Debuff","Buff","Summon"]),
    threats: "DMG, Debuff, Buff and Summon are visible. Check when summons appear and which status effects are applied; keep support units safe. Exact effects are not yet verified.",
    note: "Source: user-provided screenshots; this Conquest floor was locked."
  }),
  144: Object.freeze({
    name: "Amaterasu Fragment", emoji: "🌞",
    artwork: { filename: "amaterasu-fragment-f144.webp", asset: "./assets/conquest/amaterasu-fragment-f144.webp.b64" },
    level: 394, rank: "Master",
    stats: Object.freeze({
      hp: "461B", atk: "18.1M", def: "21.7M", spd: "7.1M",
      resilience: "240", critRate: "61.4%", critDamage: "50%",
      critResistance: "32.5%", blockRate: "53.5%", blockEfficiency: "100%",
      accuracy: "27.5%", damageBoost: "45.7%", damageResistance: "43.9%",
      healingBoost: "0%", effectHitRate: "172K", effectResistance: "172K",
      elementalMastery: "215K", elementalResistance: "215K",
      physicalMastery: "215K", physicalResistance: "215K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 16.1K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 16.1K each"
    }),
    skillLabels: Object.freeze(["DMG","DMG","DMG","Heal"]),
    threats: "Three damaging skills plus a Heal skill. Its healing can prolong the fight; look for safe opportunities to pressure damage and consider healing reduction if your team has it. Heal timing and exact effects are not yet verified.",
    note: "Source: supplied game screenshots; this Conquest floor was locked."
  }),
  145: Object.freeze({
    name: "Taowu", emoji: "🐗",
    artwork: { filename: "taowu-f145.webp", asset: "./assets/conquest/taowu-f145.webp.b64" },
    level: 400, rank: "Master",
    stats: Object.freeze({
      hp: "488B", atk: "16.6M", def: "25.4M", spd: "7.94M",
      resilience: "240", critRate: "61.5%", critDamage: "50%",
      critResistance: "32.5%", blockRate: "53.6%", blockEfficiency: "100%",
      accuracy: "27.5%", damageBoost: "45.7%", damageResistance: "43.9%",
      healingBoost: "0%", effectHitRate: "180K", effectResistance: "180K",
      elementalMastery: "226K", elementalResistance: "226K",
      physicalMastery: "226K", physicalResistance: "226K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 16.4K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 16.4K each"
    }),
    skillLabels: Object.freeze(["Knockback","Knockback","DMG","Movement","Buff"]),
    threats: "Two Knockback skills, Movement, Buff and a DMG skill are shown. High 25.4M DEF and positioning disruption are the main concerns. Protect back-line placement and inspect its Buff and movement triggers.",
    note: "Source: supplied game screenshots; this Conquest floor was locked."
  }),
  146: Object.freeze({
    name: "Qiongqi", emoji: "🐺",
    artwork: { filename: "qiongqi-f146.webp", asset: "./assets/conquest/qiongqi-f146.webp.b64" },
    level: 406, rank: "Master",
    stats: Object.freeze({
      hp: "517B", atk: "20.8M", def: "22.2M", spd: "8.54M",
      resilience: "240", critRate: "58.4%", critDamage: "50%",
      critResistance: "30.1%", blockRate: "53.7%", blockEfficiency: "100%",
      accuracy: "27.6%", damageBoost: "45.7%", damageResistance: "43.9%",
      healingBoost: "0%", effectHitRate: "189K", effectResistance: "189K",
      elementalMastery: "237K", elementalResistance: "237K",
      physicalMastery: "237K", physicalResistance: "237K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 16.6K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 16.6K each"
    }),
    skillLabels: Object.freeze(["Movement","Debuff","DMG","DMG","Buff"]),
    threats: "Movement, Debuff, two DMG skills and a Buff are visible. Its 20.8M ATK and 8.54M SPD create pressure; keep cleansing and defensive responses available where possible. Exact effects and elemental weaknesses remain unverified.",
    note: "Source: supplied game screenshots; this Conquest floor was locked."
  }),
  147: Object.freeze({
    name: "Dusty Arbiter", emoji: "👻",
    artwork: { filename: "dusty-arbiter-f147.webp", asset: "./assets/conquest/dusty-arbiter-f147.webp.b64" },
    level: 412, rank: "Master",
    stats: Object.freeze({
      hp: "550B", atk: "20.8M", def: "24.9M", spd: "9.42M",
      resilience: "240", critRate: "55.2%", critDamage: "50%",
      critResistance: "27.6%", blockRate: "53.7%", blockEfficiency: "100%",
      accuracy: "27.6%", damageBoost: "45.8%", damageResistance: "43.9%",
      healingBoost: "0%", effectHitRate: "200K", effectResistance: "200K",
      elementalMastery: "250K", elementalResistance: "250K",
      physicalMastery: "250K", physicalResistance: "250K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 16.9K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 16.9K each"
    }),
    skillLabels: Object.freeze(["DMG", "Dispel", "Summon", "DMG"]),
    threats: "Dispel and Summon appear alongside two DMG skills. Be prepared for buff removal and summoned enemies; exact timing, targets and effects are not confirmed.",
    note: "Source: user-provided F147 game screenshots; floor was locked."
  }),
  148: Object.freeze({
    name: "Swordlion", emoji: "🦁",
    artwork: { filename: "swordlion-f148.webp", asset: "./assets/conquest/swordlion-f148.webp.b64" },
    level: 418, rank: "Master",
    stats: Object.freeze({
      hp: "584B", atk: "19.6M", def: "28M", spd: "10M",
      resilience: "240", critRate: "55.3%", critDamage: "50%",
      critResistance: "27.6%", blockRate: "53.8%", blockEfficiency: "100%",
      accuracy: "27.6%", damageBoost: "45.8%", damageResistance: "43.9%",
      healingBoost: "0%", effectHitRate: "210K", effectResistance: "210K",
      elementalMastery: "263K", elementalResistance: "263K",
      physicalMastery: "263K", physicalResistance: "263K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 17.2K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 17.2K each"
    }),
    skillLabels: Object.freeze(["Unlabeled skill", "DMG", "DMG", "DMG", "DMG", "Additional skill partially shown"]),
    threats: "Four labeled DMG skills are visible, as well as an unlabeled first skill and a further icon cut off at the right edge. High 28M DEF and 10M SPD may demand sustained damage and defensive coverage; verify exact skill effects in-game.",
    note: "Source: user-provided F148 game screenshots; floor was locked. Not all skill labels were visible."
  }),
  149: Object.freeze({
    name: "Bronze Blademon", emoji: "🔥",
    artwork: { filename: "bronze-blademon-f149.webp", asset: "./assets/conquest/bronze-blademon-f149.webp.b64" },
    level: 424, rank: "Master",
    stats: Object.freeze({
      hp: "618B", atk: "24.9M", def: "26.5M", spd: "10.2M",
      resilience: "240", critRate: "55.4%", critDamage: "50%",
      critResistance: "27.7%", blockRate: "53.9%", blockEfficiency: "100%",
      accuracy: "27.7%", damageBoost: "45.8%", damageResistance: "44%",
      healingBoost: "0%", effectHitRate: "220K", effectResistance: "220K",
      elementalMastery: "276K", elementalResistance: "276K",
      physicalMastery: "276K", physicalResistance: "276K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 17.4K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 17.4K each"
    }),
    skillLabels: Object.freeze(["DMG", "DMG", "DMG", "DMG"]),
    threats: "Four damaging skills are visible; with 24.9M ATK and 10.2M SPD, plan for sustained incoming damage. Specific attack ranges, elements and effects are not yet verified.",
    note: "Source: supplied F149 game screenshots; floor was locked."
  }),
  150: Object.freeze({
    name: "Oathbound Guard", emoji: "🛡️",
    artwork: { filename: "oathbound-guard-f150.webp", asset: "./assets/conquest/oathbound-guard-f150.webp.b64" },
    level: 430, rank: "Master",
    stats: Object.freeze({
      hp: "654B", atk: "26.7M", def: "29.6M", spd: "9.52M",
      resilience: "240", critRate: "55.5%", critDamage: "50%",
      critResistance: "27.7%", blockRate: "54%", blockEfficiency: "100%",
      accuracy: "27.7%", damageBoost: "45.9%", damageResistance: "44%",
      healingBoost: "0%", effectHitRate: "232K", effectResistance: "232K",
      elementalMastery: "290K", elementalResistance: "290K",
      physicalMastery: "290K", physicalResistance: "290K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 17.7K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 17.7K each"
    }),
    skillLabels: Object.freeze(["DMG", "Ailment", "DMG", "DMG"]),
    threats: "Three DMG skills and an Ailment skill are visible. High ATK (26.7M) and DEF (29.6M) call for reliable mitigation and status-effect countermeasures. Exact ailment and skill timing are unverified.",
    note: "Source: supplied F150 game screenshots; floor was locked."
  }),
  151: Object.freeze({
    name: "White Tiger", emoji: "🐯",
    artwork: { filename: "white-tiger-f151.webp", asset: "./assets/conquest/white-tiger-f151.webp.b64" },
    level: 166, rank: "Paragon",
    stats: Object.freeze({
      hp: "40.4B", atk: "945K", def: "2M", spd: "716K",
      resilience: "240", critRate: "42.2%", critDamage: "50%",
      critResistance: "31.2%", blockRate: "39.2%", blockEfficiency: "100%",
      accuracy: "30%", damageBoost: "30.3%", damageResistance: "109.1%",
      healingBoost: "0%", effectHitRate: "115K", effectResistance: "86.3K",
      elementalMastery: "287K", elementalResistance: "287K",
      physicalMastery: "287K", physicalResistance: "287K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 12.3K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 12.3K each"
    }),
    skillLabels: Object.freeze(["DMG", "DMG", "DMG", "Movement", "Buff"]),
    threats: "Paragon rank begins at F151 in the supplied screenshots; its level and base stats differ sharply from F150. Three DMG skills, Movement and Buff are shown. DMG RES is unusually high at 109.1%; exact mitigation formula, Buff and Movement effects remain unverified.",
    note: "Source: supplied F151 game screenshots; floor was locked. Paragon rank and level 166 are intentional, not extrapolated."
  }),
  152: Object.freeze({
    name: "Cloudmist Phoenix", emoji: "🦅",
    artwork: { filename: "cloudmist-phoenix-f152.webp", asset: "./assets/conquest/cloudmist-phoenix-f152.webp.b64" },
    level: 168, rank: "Paragon",
    stats: Object.freeze({
      hp: "41.4B", atk: "1.56M", def: "2.22M", spd: "661K",
      resilience: "240", critRate: "43%", critDamage: "50%",
      critResistance: "31.8%", blockRate: "40%", blockEfficiency: "100%",
      accuracy: "30.6%", damageBoost: "30.8%", damageResistance: "111.1%",
      healingBoost: "0%", effectHitRate: "121K", effectResistance: "91K",
      elementalMastery: "303K", elementalResistance: "303K",
      physicalMastery: "303K", physicalResistance: "303K",
      elementalAffinities: "Wind / Water / Fire / Light / Dark: 12.6K each",
      elementalAegis: "Wind / Water / Fire / Light / Dark: 12.6K each"
    }),
    skillLabels: Object.freeze(["Debuff", "Debuff", "Debuff", "Debuff"]),
    threats: "All four visible skills are marked Debuff. Prioritize status protection or cleansing if available and plan around high 111.1% DMG RES. The exact debuffs, targets and resistance calculation have not been confirmed.",
    note: "Source: supplied F152 game screenshots; floor was locked."
  }),
  153: Object.freeze({
    name: "Withered Queen", emoji: "🥀",
    artwork: { filename: "withered-queen-f153.webp", asset: "./assets/conquest/withered-queen-f153.webp.b64" },
    level: 170, rank: "Paragon",
    stats: Object.freeze({
      "hp": "43.7B",
      "atk": "1.71M",
      "def": "2.17M",
      "spd": "778K",
      "resilience": "240",
      "critRate": "44.1%",
      "critDamage": "50%",
      "critResistance": "32.6%",
      "blockRate": "41.1%",
      "blockEfficiency": "100%",
      "accuracy": "31.4%",
      "damageBoost": "31.9%",
      "damageResistance": "115%",
      "healingBoost": "0%",
      "effectHitRate": "129K",
      "effectResistance": "97.1K",
      "elementalMastery": "323K",
      "elementalResistance": "323K",
      "physicalMastery": "323K",
      "physicalResistance": "323K",
      "elementalAffinities": "Wind / Water / Fire / Light / Dark: 12.9K each",
      "elementalAegis": "Wind / Water / Fire / Light / Dark: 12.9K each"
    }),
    skillLabels: Object.freeze(["DMG","DMG","DMG","Debuff"]),
    threats: "Three DMG skills and a Debuff are shown. Keep cleansing/status protection ready if available and maintain defensive coverage through repeated hits. Purrwikimania's damage formula indicates that 115% DMG RES reduces damage dealt to the boss; exact Debuff targets and effects remain unverified.",
    note: "Boss identity, skill types and stats: supplied F153 game screenshots (locked); general mechanics guidance: Purrwikimania /combat."
  }),
  154: Object.freeze({
    name: "Chaos Hound", emoji: "🐺",
    artwork: { filename: "chaos-hound-f154.webp", asset: "./assets/conquest/chaos-hound-f154.webp.b64" },
    level: 172, rank: "Paragon",
    stats: Object.freeze({
      "hp": "46.6B",
      "atk": "2.01M",
      "def": "2.09M",
      "spd": "881K",
      "resilience": "240",
      "critRate": "44.8%",
      "critDamage": "50%",
      "critResistance": "33.1%",
      "blockRate": "41.8%",
      "blockEfficiency": "100%",
      "accuracy": "31.9%",
      "damageBoost": "32.4%",
      "damageResistance": "116.8%",
      "healingBoost": "0%",
      "effectHitRate": "137K",
      "effectResistance": "103K",
      "elementalMastery": "344K",
      "elementalResistance": "344K",
      "physicalMastery": "344K",
      "physicalResistance": "344K",
      "elementalAffinities": "Wind / Water / Fire / Light / Dark: 13K each",
      "elementalAegis": "Wind / Water / Fire / Light / Dark: 13K each"
    }),
    skillLabels: Object.freeze(["DMG","Movement","Movement"]),
    threats: "Two Movement skills and one DMG skill are visible. Avoid depending on a fixed boss position; leave room for repositioning and protect vulnerable teammates. Its 881K SPD is above F153's 778K, and 116.8% DMG RES calls for sustained damage. Exact movement ranges and targets remain unverified.",
    note: "Boss identity, skill types and stats: supplied F154 game screenshots (locked); general mechanics guidance: Purrwikimania /combat."
  }),
  155: Object.freeze({
    name: "Fallen Hero", emoji: "⚔️",
    artwork: { filename: "fallen-hero-f155.webp", asset: "./assets/conquest/fallen-hero-f155.webp.b64" },
    level: 174, rank: "Paragon",
    stats: Object.freeze({
      "hp": "47.5B",
      "atk": "1.86M",
      "def": "2.37M",
      "spd": "848K",
      "resilience": "240",
      "critRate": "45.5%",
      "critDamage": "50%",
      "critResistance": "33.6%",
      "blockRate": "42.4%",
      "blockEfficiency": "100%",
      "accuracy": "32.3%",
      "damageBoost": "32.9%",
      "damageResistance": "118.5%",
      "healingBoost": "0%",
      "effectHitRate": "144K",
      "effectResistance": "108K",
      "elementalMastery": "361K",
      "elementalResistance": "361K",
      "physicalMastery": "361K",
      "physicalResistance": "361K",
      "elementalAffinities": "Wind / Water / Fire / Light / Dark: 13.2K each",
      "elementalAegis": "Wind / Water / Fire / Light / Dark: 13.2K each"
    }),
    skillLabels: Object.freeze(["DMG","DMG","DMG","Buff"]),
    threats: "Three DMG skills and a Buff are shown. Prepare for incoming damage and inspect the Buff's effects before choosing whether to dispel it. Its 2.37M DEF and 118.5% DMG RES make consistent damage important; exact Buff and attack effects remain unverified.",
    note: "Boss identity, skill types and stats: supplied F155 game screenshots (locked); general mechanics guidance: Purrwikimania /combat."
  }),
  156: Object.freeze({
    name: "Chaos Herald", emoji: "🌀",
    artwork: { filename: "chaos-herald-f156.webp", asset: "./assets/conquest/chaos-herald-f156.webp.b64" },
    level: 176, rank: "Paragon",
    stats: Object.freeze({
      "hp": "48.1B",
      "atk": "1.89M",
      "def": "2.4M",
      "spd": "860K",
      "resilience": "240",
      "critRate": "46.2%",
      "critDamage": "50%",
      "critResistance": "34.1%",
      "blockRate": "43%",
      "blockEfficiency": "100%",
      "accuracy": "32.8%",
      "damageBoost": "33.3%",
      "damageResistance": "120.2%",
      "healingBoost": "0%",
      "effectHitRate": "151K",
      "effectResistance": "113K",
      "elementalMastery": "377K",
      "elementalResistance": "377K",
      "physicalMastery": "377K",
      "physicalResistance": "377K",
      "elementalAffinities": "Wind / Water / Fire / Light / Dark: 13.3K each",
      "elementalAegis": "Wind / Water / Fire / Light / Dark: 13.3K each"
    }),
    skillLabels: Object.freeze(["Summon","Summon","Heal","Summon"]),
    threats: "Three Summon skills and one Heal skill are visible. Expect summoned threats and potential self-sustain; bring reliable damage and consider add control or healing reduction if available. The wiki notes summons may participate in the combat timeline, but these specific summons and Heal effects remain unverified. DMG RES is 120.2%.",
    note: "Boss identity, skill types and stats: supplied F156 game screenshots (locked); general mechanics guidance: Purrwikimania /combat."
  })
});

function knownBoss(floor) {
  return BOSS_DATA[Number(floor)] || null;
}

// Display compact decision-useful Intel; every stat is also accessible through
// the Detailed Stats button, without requiring a staff input or daily update.
// Information panels are intentionally short and single-purpose on mobile.
// The full screenshot stats are preserved in BOSS_DATA, but shown one page
// at a time rather than as a dense wall of fields.
const INTEL_PAGES = [
  { key: "summary", label: "Quick Stats", emoji: "📊", description: "HP, attack, defense and key risks" },
  { key: "offense", label: "Offensive Stats", emoji: "⚔️", description: "Critical hits, accuracy and attack effects" },
  { key: "defense", label: "Defensive Stats", emoji: "🛡️", description: "Block, mitigation and resistances" },
  { key: "elements", label: "Elements & Weaknesses", emoji: "🎯", description: "Elemental affinities and aegis" },
  { key: "tactics", label: "Skills & Strategy", emoji: "🌀", description: "Skills, threats and battle priorities" },
  { key: "upcoming", label: "Upcoming Floors", emoji: "⏭️", description: "The next five Conquest floors" }
];

function infoViewsMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("cintel_info_view")
      .setPlaceholder("Switch intel page")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions([
        ...INTEL_PAGES.map(page => ({
          label: page.label, value: page.key, emoji: page.emoji,
          description: page.description
        })),
        { label: "Back to More Options", value: "back", emoji: "↩️" }
      ])
  );
}

function intelEmbed(floor, view = "summary") {
  const boss = knownBoss(floor);
  const titleName = boss ? boss.name : "Unknown Boss";
  const embed = new EmbedBuilder()
    .setColor(0x8176CE)
    .setFooter({ text: "F" + floor + " • Select another page below • Stats are not live" });

  if (view === "upcoming") {
    const nextFloors = Array.from({ length: Math.max(0, Math.min(5, MAX_FLOOR - floor)) },
      (_, i) => floor + i + 1);
    const identified = nextFloors.filter(f => knownBoss(f));
    const unknown = nextFloors.filter(f => !knownBoss(f));
    const lines = identified.map(f => {
      const item = knownBoss(f);
      return "**F" + f + "** · " + item.name + " · Lv. " + item.level + " · " + item.rank;
    });
    if (unknown.length) {
      lines.push("**F" + unknown[0] + (unknown.length > 1 ? "–F" + unknown.at(-1) : "") +
        "** · Boss profiles not yet verified");
    }
    return embed
      .setTitle("⏭️ Upcoming Conquest Floors")
      .setDescription((lines.join("\n") || "No higher floors within the tracked range.") +
        "\n\n" + "The floor tracker advances with **Boss Down**. " +
        "Unknown boss names and stats are never guessed.")
      .setFooter({ text: "Current guild target: F" + floor + " • No daily reporting needed" });
  }

  if (!boss) {
    return embed
      .setTitle("⚔️ F" + floor + " · " + titleName)
      .setDescription(
        "**" + (view === "tactics" ? "Combat strategy" : "Monster stats") + "**\n\n" +
        "This floor does not yet have a verified boss profile.\n\n" +
        "🔎 Reference: " + ENEMIES_URL + "\n\n" +
        "Vestra will keep the floor tracker working without inventing details."
      );
  }

  const st = boss.stats;
  const title = (boss.emoji || "⚔️") + " F" + floor + " · " + boss.name;
  const idLine = "**" + boss.rank + " · Lv. " + boss.level + "**";

  if (view === "offense") {
    return embed.setTitle("⚔️ Offensive Stats · " + boss.name)
      .setDescription(idLine + "\n\n" +
        "**⚔️ Direct damage**\n" +
        "ATK **" + st.atk + "**  •  SPD **" + st.spd + "**\n" +
        "Crit Rate **" + st.critRate + "**  •  Crit DMG **" + st.critDamage + "**\n\n" +
        "**🎯 Accuracy & amplification**\n" +
        "DMG Boost **" + st.damageBoost + "**  •  Accuracy **" + st.accuracy + "**\n" +
        "Effect Hit **" + st.effectHitRate + "**\n" +
        "Elemental / Physical Mastery **" + st.elementalMastery + " / " + st.physicalMastery + "**");
  }

  if (view === "defense") {
    return embed.setTitle("🛡️ Defensive Stats · " + boss.name)
      .setDescription(idLine + "\n\n" +
        "**🛡️ Damage mitigation**\n" +
        "Block Rate **" + st.blockRate + "**  •  Efficiency **" + st.blockEfficiency + "**\n" +
        "DMG RES **" + st.damageResistance + "**  •  Crit RES **" + st.critResistance + "**\n\n" +
        "**🔰 Other defenses**\n" +
        "DEF **" + st.def + "**  •  Resilience **" + st.resilience + "**\n" +
        "Effect RES **" + st.effectResistance + "**\n" +
        "Elemental / Physical RES **" + st.elementalResistance + " / " + st.physicalResistance + "**\n" +
        "Healing Boost **" + st.healingBoost + "**");
  }

  if (view === "elements") {
    return embed.setTitle("🎯 Elements & Weaknesses · " + boss.name)
      .setDescription(idLine + "\n\n" +
        "**🌈 Elemental Affinity**\n" +
        "Wind · Water · Fire · Light · Dark\n" +
        "**" + (st.elementalAffinities.match(/[\d.]+K/)?.[0] || "unknown") + " each**\n\n" +
        "**🔰 Elemental Aegis**\n" +
        "Wind · Water · Fire · Light · Dark\n" +
        "**" + (st.elementalAegis.match(/[\d.]+K/)?.[0] || "unknown") + " each**\n\n" +
        "**No confirmed elemental weakness.** The displayed elemental values are equal.");
  }

  if (view === "tactics") {
    return embed.setTitle("🌀 Skills & Strategy · " + boss.name)
      .setDescription(idLine + "\n\n" +
        "**Observed skill labels**\n" +
        "**" + boss.skillLabels.join(" · ") + "**\n" +
        "Exact triggers and effects have not been confirmed.\n\n" +
        "**⚠️ Biggest threats**\n" +
        "• Crit Rate **" + st.critRate + "** — prioritize survivability.\n" +
        "• Block **" + st.blockRate + "** and DMG RES **" + st.damageResistance + "** — damage may be reduced.\n\n" +
        "**✅ Before your next run**\n" +
        (boss.threats || "Check boss skill details.") + "\nPrepare your team for the listed mechanics.");
  }

  return embed.setTitle("📊 Quick Stats · " + boss.name)
    .setDescription(idLine + "\n\n" +
      "**❤️ Core stats**\n" +
      "HP **" + st.hp + "**  •  ATK **" + st.atk + "**\n" +
      "DEF **" + st.def + "**  •  SPD **" + st.spd + "**\n\n" +
      "**⚠️ Key numbers**\n" +
      "Crit **" + st.critRate + "**  •  Block **" + st.blockRate + "**\n" +
      "DMG RES **" + st.damageResistance + "**\n\n" +
      "Choose **Offense**, **Defense**, **Elements**, or **Skills** for more.");
}

function intelViewPayload(floor, view) {
  return {
    content: "",
    embeds: [intelEmbed(floor, view)],
    components: [infoViewsMenu()],
    allowedMentions: { parse: [] }
  };
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
    ? (boss.emoji || "⚔️") + " CONQUEST INTEL  |  F" + floor + " • " + boss.name
    : "⚔️ CONQUEST INTEL  |  FLOOR " + floor;
  const embed = new EmbedBuilder()
    .setColor(0x8176CE)
    .setTitle(title)
    .setDescription(boss
      ? "**" + boss.rank.toUpperCase() + " • LV. " + boss.level + "**\n" +
        "❤️ HP " + st.hp + "   •   ⚔️ ATK " + st.atk + "\n" +
        "🛡️ DEF " + st.def + "   •   💨 SPD " + st.spd + "\n\n" +
        "**⚠️ Key threats**\n" +
        "Block " + st.blockRate + "  •  DMG RES " + st.damageResistance +
        "  •  Crit " + st.critRate + "\n" +
        "Skills: **" + boss.skillLabels.join(" · ") + "**\n\n" +
        "**🎯 Weakness & approach**\n" +
        "Elemental weakness unconfirmed (each elemental Affinity/Aegis: " +
        (st.elementalAffinities.match(/[\d.]+K/)?.[0] || "unknown") + ").\n" +
        (boss.threats || "Check the skills in-game.")
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
        ? "Boss details: in-game screenshots • Floor tracked by Vestra"
        : "Floor tracked by Vestra • Boss data not verified"
    });
  if (includeArtwork && boss?.artwork) {
    embed.setImage("attachment://" + boss.artwork.filename);
  }
  return embed;
}

function nextEmbed(floor, source) {
  return intelEmbed(floor, "upcoming");
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
    if (selection === "stats" || selection === "tactics" || selection === "upcoming") {
      const view = selection === "stats" ? "summary" : selection;
      await interaction.update(intelViewPayload(floor, view));
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
  if (interaction.isStringSelectMenu() && id === "cintel_info_view") {
    const selected = interaction.values[0];
    if (selected === "back") {
      const staff = await staffAccess(interaction, isStaff);
      await interaction.update({
        content: "📖 **Conquest Intel** — choose an option:",
        embeds: [],
        components: [optionsMenu(staff)],
        allowedMentions: { parse: [] }
      });
      return true;
    }
    if (!INTEL_PAGES.some(page => page.key === selected)) {
      await interaction.update({ content: "Unknown intel view.", embeds: [], components: [] });
      return true;
    }
    const progress = await getProgress();
    await interaction.update(intelViewPayload(Number(progress.floor), selected));
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
        ...intelViewPayload(Number(current.floor), "summary"),
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
        ...intelViewPayload(floor, "upcoming"),
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
