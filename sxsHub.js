import { ChannelType } from "discord.js";
import { createHash } from "node:crypto";
import { currentGiftCodes, parseCodes, parseHome, parseRoadmapWeek, parseSeasonIndex, parseSeasonPage } from "./src/sxs/valkyrieParsers.js";

const SXS_CATEGORY_MATCH = "SWORD X STAFF";
const REFRESH_MS = 30 * 60 * 1000;

const SOURCE = {
  home: "https://www.valkyrie.tips/",
  codes: "https://www.valkyrie.tips/codes",
  database: "https://www.valkyrie.tips/database",
  builds: "https://www.valkyrie.tips/builds/curated",
  guides: "https://www.valkyrie.tips/guides",
  roadmap: "https://www.valkyrie.tips/tools/roadmap",
  seasons: "https://www.valkyrie.tips/seasons"
};

const CHANNEL_DEFS = [
  {
    key: "seasonal",
    name: "seasonal-info",
    topic: "Live Sword x Staff season information, dates, class tier, region, milestones, and upcoming season details."
  },
  {
    key: "weekly",
    name: "weekly-rotation",
    topic: "Current Sword x Staff Grand Treasure Hunt, rotating reward, mini-game, reset, and next weekly rotation."
  },
  {
    key: "roadmap",
    name: "sxs-roadmap",
    topic: "Upcoming Sword x Staff progression milestones, dungeons, relic phases, regions, and seasonal unlocks."
  },
  {
    key: "codes",
    name: "gift-codes",
    topic: "Current Sword x Staff gift codes and rewards, maintained automatically by Vestra."
  },
  {
    key: "database",
    name: "sxs-database",
    topic: "Sword x Staff reference hub for skills, relics, Fantomons, companions, equipment, gems, recipes, dungeon gear, and more."
  },
  {
    key: "builds",
    name: "builds-and-guides",
    topic: "Sword x Staff class builds, progression guides, and season-aware reference links."
  },
  {
    key: "maps",
    name: "ingredient-maps",
    topic: "Sword x Staff gathering maps for ingredients, rare plants, epic ingredients, and gem nodes by kingdom."
  },
  {
    key: "news",
    name: "updates-and-news",
    topic: "Latest official Sword x Staff announcements and game news, collected into one clean live board."
  }
];

let activeHub = null;

function truncate(value, max = 1024) {
  const text = String(value ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function normalizeDiscordName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function flattenRoleIds(staffRoles) {
  const values = Array.isArray(staffRoles)
    ? staffRoles
    : Object.values(staffRoles || {});

  return [...new Set(values
    .flatMap(value => Array.isArray(value) ? value : [value])
    .filter(value => typeof value === "string" && /^\d+$/.test(value)))];
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Vestra-Ashen-Warriors/1.0 (+Discord information board)",
        Accept: "text/html,application/xhtml+xml"
      },
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function formatMilestone(item) {
  const day = item.serverDay ? ` • Server Day ${item.serverDay}` : "";
  const detail = item.detail.slice(0, 3).join(" · ");
  return `**${item.label}${day}**\n${detail || "Progression milestone"}`;
}

function externalUrl(href) {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  return `https://www.valkyrie.tips${href.startsWith("/") ? "" : "/"}${href}`;
}

async function fetchLiveData() {
  const homeHtml = await fetchHtml(SOURCE.home);
  const home = parseHome(homeHtml);
  if (!home.season?.number) throw new Error("Current season could not be detected from the SxS source.");

  const seasonUrl = `${SOURCE.seasons}/s${home.season.number}`;
  const [seasonHtml, codesHtml, seasonsHtml, roadmapHtml] = await Promise.all([
    fetchHtml(seasonUrl),
    fetchHtml(SOURCE.codes),
    fetchHtml(SOURCE.seasons),
    fetchHtml(SOURCE.roadmap)
  ]);

  const season = parseSeasonPage(seasonHtml, home.season);
  const seasonIndex = parseSeasonIndex(seasonsHtml, home.season.number);
  const roadmapWeek = parseRoadmapWeek(roadmapHtml);
  const codes = parseCodes(codesHtml);
  // Dedicated current-code listing is authoritative; do not revive removed codes from the homepage.
  return {
    fetchedAt: new Date().toISOString(),
    seasonUrl,
    home,
    season,
    seasonIndex,
    roadmapWeek,
    codes: currentGiftCodes(codes)
  };
}

function plainBoard(title, sections, sourceUrl, stale = false) {
  const body = [
    `# ✦ ${title.replace(/^SWORD X STAFF\s*\|\s*/i, "")}`,
    "",
    ...sections.filter(Boolean),
    "",
    stale ? "_Showing the last confirmed SxS information._" : "_Updated automatically by Vestra when the information changes._",
    sourceUrl ? `**Reference:** [Open source](${sourceUrl})` : null
  ].filter(Boolean).join("\n");

  return {
    content: truncate(body, 1990),
    embeds: [],
    components: [],
    allowedMentions: { parse: [] },
    flags: 4
  };
}

function buildPayloads(data, stale = false) {
  const seasonNumber = data.home.season.number;
  const region = data.season.region || data.home.season.region || "Current region";
  const serverDay = data.home.season.serverDay;
  const tier = data.season.tier || data.seasonIndex.current?.tier;
  const milestones = data.season.milestones || [];
  const now = Date.now();
  const upcoming = milestones.filter(item => new Date(item.date).getTime() >= now - 12 * 3600_000);
  const past = milestones.filter(item => new Date(item.date).getTime() < now - 12 * 3600_000);
  const nextMilestone = upcoming[0] || null;
  const recentMilestone = past[past.length - 1] || null;
  const currentSummary = data.seasonIndex.current;
  const nextSeason = data.seasonIndex.next;

  const seasonal = plainBoard(
    `SWORD X STAFF | SEASON ${seasonNumber}`,
    [
      `**Region:** ${region}`,
      tier ? `**Class Tier:** T${tier}` : null,
      serverDay ? `**Server Day:** ${serverDay}` : null,
      currentSummary?.dateRange ? `**Season Dates:** ${currentSummary.dateRange}` : null,
      data.season.classes ? `\n**Current Classes**\n${truncate(data.season.classes, 650)}` : null,
      `\n**Next Milestone**\n${nextMilestone ? formatMilestone(nextMilestone) : "No later milestone is currently listed for this season."}`,
      `\n**Most Recent Unlock**\n${recentMilestone ? formatMilestone(recentMilestone) : "Season progression is being tracked."}`,
      `\n**Next Season**\n${nextSeason ? `Season ${nextSeason.number} — ${nextSeason.region}\nT${nextSeason.tier} • ${nextSeason.dateRange}` : "No upcoming season is currently listed."}`
    ],
    data.seasonUrl,
    stale
  );

  const weekly = plainBoard(
    "SWORD X STAFF | WEEKLY ROTATION",
    [
      `**Grand Treasure Hunt**\n${data.home.weekly.hunt || "No current hunt detected."}`,
      `\n**Level 5 Reward**\n${data.home.weekly.reward || "Reward information unavailable."}`,
      `\n**Mini-game**\n${data.home.weekly.miniGame || "Mini-game information unavailable."}`,
      `\n**Next Rotation**\n${data.home.weekly.next || "Next rotation has not been published yet."}`,
      `\n**Reset**\n${data.roadmapWeek.reset || "Check the live roadmap for the exact reset time."}`
    ],
    SOURCE.home,
    stale
  );

  const roadmapLines = (upcoming.length ? upcoming : milestones.slice(-6))
    .slice(0, 6)
    .map(formatMilestone);

  const roadmap = plainBoard(
    `SWORD X STAFF | SEASON ${seasonNumber} ROADMAP`,
    [
      roadmapLines.length
        ? roadmapLines.join("\n\n")
        : "No roadmap milestones were available from the live source."
    ],
    SOURCE.roadmap,
    stale
  );

  const formatRewards = value => String(value || "")
    .replace(/(\S)(?=\d[\d,]*x\s)/g, "$1 · ")
    .replace(/\s*·\s*/g, " · ")
    .trim();
  const codeLines = data.codes
    .slice(0, 12)
    .map(item => `**${item.code}**\n${truncate(formatRewards(item.reward), 100)}`);
  const extraCodes = data.codes.length > 12
    ? `\n${data.codes.length - 12} more codes: [View full list](${SOURCE.codes})`
    : null;

  const codes = plainBoard(
    "SWORD X STAFF | GIFT CODES",
    [
      codeLines.length ? codeLines.join("\n\n") : "No codes currently listed.",
      extraCodes,
      "\n**Redeem:** Main Menu → User Center → Gift Code"
    ],
    SOURCE.codes,
    stale
  );

  const database = plainBoard(
    "SWORD X STAFF | DATABASE",
    [
      `Reference information for **Season ${seasonNumber}** and the rest of Sword x Staff.`,
      "\n**Skills & Charms**\nRarity scaling, effects, and keywords",
      "\n**Relics**\nSeason, region, element, and rarity filters",
      "\n**Fantomons & Companions**\nAbilities, skills, and progression",
      "\n**Equipment & Gems**\nStat affixes and value ranges",
      "\n**Recipes & Food**\nIngredients and effects",
      "\n**Dungeon Gear**\nSets and 2-piece / 4-piece bonuses",
      "\n**Monsters, Skins & Item Values**\nAdditional reference data"
    ],
    SOURCE.database,
    stale
  );

  const builds = plainBoard(
    "SWORD X STAFF | BUILDS & GUIDES",
    [
      `**Current Progression:** Season ${seasonNumber} • ${region}${tier ? ` • T${tier}` : ""}`,
      data.season.classes ? `\n**Current Class Paths**\n${truncate(data.season.classes, 900)}` : null,
      "\nClass builds: <https://www.valkyrie.tips/builds/curated>",
      "[Browse guides](https://www.valkyrie.tips/guides)"
    ],
    SOURCE.builds,
    stale
  );

  const newsLines = data.home.news.slice(0, 4).map(item => {
    const url = externalUrl(item.href);
    const title = truncate(item.label.replace(/\s+/g, " ").trim(), 140);
    return url ? `• [${title}](${url})` : `• ${title}`;
  });

  const news = plainBoard(
    "SWORD X STAFF | UPDATES & NEWS",
    [
      "**Latest announcements**",
      newsLines.length
        ? newsLines.join("\n\n")
        : "No recent official announcements detected.",
      "\nOlder announcements are available through the source below."
    ],
    SOURCE.home,
    stale
  );

  const maps = plainBoard(
    "SWORD X STAFF | INGREDIENT MAPS BY REGION",
    [
      "Select your kingdom in the gathering map, then filter for rare ingredients, epic ingredients, or gem nodes.",
      "\n**Season 1 — Verdantglade**\n[View ingredient locations](https://www.purrwikimania.com/es/gathering-map)",
      "\n**Season 1 — Cinder Ridge**\n[View ingredient locations](https://www.purrwikimania.com/es/gathering-map)",
      "\n**Season 1 — Aqualis**\n[View ingredient locations](https://www.purrwikimania.com/es/gathering-map)",
      "\n**Season 2 — Loong Haven**\n[View ingredient and gem locations](https://www.purrwikimania.com/es/gathering-map)",
      "\n**Season 3 — Aethyris**\n[View ingredient and gem locations](https://www.purrwikimania.com/es/gathering-map)",
      "\n**Season 4 — Harpadia (future for earlier servers)**\n[View ingredient and gem locations](https://www.purrwikimania.com/es/gathering-map)",
      "\n**Season 5 — Ignis (future for earlier servers)**\n[View ingredient and gem locations](https://www.purrwikimania.com/es/gathering-map)",
      "\n**Season 6 — Aeperis (upcoming)**\nIngredient node coverage not yet confirmed. Will be added when a reliable map is available.",
      "\n**Additional world map:** [Explore all regions](https://swordxstaff-compass.com/)",
      "\n**Note:** These links open a region-selectable map, not individual preselected maps. Unlocks vary by server; future region data is shown for preparation."
    ],
    null,
    false
  );

  return { seasonal, weekly, roadmap, codes, database, builds, maps, news };
}

function buildUnavailablePayload(def) {
  return plainBoard(
    `SWORD X STAFF | ${def.name.replaceAll("-", " ").toUpperCase()}`,
    [
      "Vestra could not reach the live SxS source during first-time setup.",
      "This message will update automatically on the next successful refresh."
    ],
    SOURCE.home,
    true
  );
}

function payloadHash(payload) {
  return createHash("sha256")
    .update(payload.content || "")
    .digest("hex");
}

async function findBoardMessage(channel, botUserId) {
  const pins = await channel.messages.fetchPins().catch(() => null);
  const pinnedItems = pins?.items ?? pins;
  const pinList = Array.isArray(pinnedItems)
    ? pinnedItems
    : pinnedItems?.values ? [...pinnedItems.values()] : [];
  for (const item of pinList) {
    const message = item?.message ?? item;
    if (message?.author?.id !== botUserId || !message?.id) continue;
    const fetched = await channel.messages.fetch(message.id).catch(() => null);
    if (fetched?.author?.id === botUserId) return fetched;
  }

  const recent = await channel.messages.fetch({ limit: 25 }).catch(() => null);
  return recent?.find(message => message?.author?.id === botUserId) || null;
}

async function ensureReadOnlyPermissions(channel, guild, client, staffRoles) {
  await channel.permissionOverwrites.edit(guild.roles.everyone, {
    SendMessages: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
    SendMessagesInThreads: false
  }).catch(error => {
    console.error(`❌ Could not set read-only permissions for #${channel.name}:`, error.message);
  });

  for (const roleId of flattenRoleIds(staffRoles)) {
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      EmbedLinks: true
    }).catch(() => {});
  }

  if (client.user?.id) {
    await channel.permissionOverwrites.edit(client.user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      EmbedLinks: true,
      ManageMessages: true
    }).catch(() => {});
  }
}

async function resolveGuild(client, remindersChannelId) {
  if (remindersChannelId) {
    const channel = await client.channels.fetch(remindersChannelId).catch(() => null);
    if (channel?.guild) return channel.guild;
  }

  return client.guilds.cache.first() || null;
}

async function ensureChannels(client, remindersChannelId, staffRoles) {
  const guild = await resolveGuild(client, remindersChannelId);
  if (!guild) throw new Error("Ashen Warriors guild could not be resolved.");

  await guild.channels.fetch();

  const category = guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildCategory &&
    normalizeDiscordName(channel.name).includes(normalizeDiscordName("SWORD X STAFF | INTEL"))
  );

  if (!category) {
    throw new Error(`Could not find the existing ${SXS_CATEGORY_MATCH} category.`);
  }

  const resolved = {};

  for (const def of CHANNEL_DEFS) {
    const wanted = normalizeDiscordName(def.name);
    // Staff control all channel names. Match existing decorated names
    // (e.g. symbols or separator characters) and NEVER create replacements.
    const channel = guild.channels.cache.find(item =>
      item.type === ChannelType.GuildText &&
      item.parentId === category.id &&
      normalizeDiscordName(item.name).endsWith(wanted)
    );

    if (!channel) {
      console.warn(
        "⚠️ SxS live hub: existing channel for " + def.name +
        " was not found. Skipping it; Vestra will not create or rename channels."
      );
      continue;
    }

    if (channel.topic !== def.topic) {
      await channel.setTopic(def.topic).catch(() => {});
    }
    await ensureReadOnlyPermissions(channel, guild, client, staffRoles);
    resolved[def.key] = channel;
  }

  return resolved;
}

async function createHub({ client, remindersChannelId, staffRoles }) {
  let channels = {};
  let lastGoodData = null;
  let refreshRunning = false;
  const hashes = new Map();

  async function upsertBoard(def, channel, payload, { leaveExistingOnFailure = false } = {}) {
    const existing = await findBoardMessage(channel, client.user.id);

    if (leaveExistingOnFailure && existing) return;

    const hash = payloadHash(payload);
    if (!existing) {
      const message = await channel.send(payload);
      await message.pin().catch(() => {});
      hashes.set(def.key, hash);
      return;
    }

    const existingHash = payloadHash({ content: existing.content || "" });
    if (existingHash !== hash) {
      await existing.edit(payload);
    }
    hashes.set(def.key, hash);
  }

  async function refresh({ ensure = false } = {}) {
    if (refreshRunning) return;
    refreshRunning = true;

    try {
      if (ensure || Object.keys(channels).length !== CHANNEL_DEFS.length) {
        channels = await ensureChannels(client, remindersChannelId, staffRoles);
      }

      let data = null;
      let stale = false;

      try {
        data = await fetchLiveData();
        lastGoodData = data;
      } catch (error) {
        console.error("❌ SxS live-data refresh failed:", error.message);
        if (lastGoodData) {
          data = lastGoodData;
          stale = true;
        }
      }

      if (!data) {
        for (const def of CHANNEL_DEFS) {
          const channel = channels[def.key];
          if (!channel?.isTextBased()) continue;
          await upsertBoard(def, channel, buildUnavailablePayload(def), { leaveExistingOnFailure: true });
        }
        return;
      }

      const payloads = buildPayloads(data, stale);

      for (const def of CHANNEL_DEFS) {
        const channel = channels[def.key];
        const payload = payloads[def.key];
        if (channel?.isTextBased() && payload) {
          await upsertBoard(def, channel, payload);
        }
      }

      console.log(`✅ SxS live information hub refreshed${stale ? " from last confirmed data" : ""}.`);
    } catch (error) {
      console.error("❌ SxS hub refresh error:", error);
    } finally {
      refreshRunning = false;
    }
  }

  await refresh({ ensure: true });
  const interval = setInterval(() => void refresh(), REFRESH_MS);

  return {
    refresh,
    stop() {
      clearInterval(interval);
    }
  };
}

export async function setupSxsHub(options) {
  if (activeHub) {
    await activeHub.refresh({ ensure: true });
    return activeHub;
  }

  activeHub = await createHub(options);
  return activeHub;
}
