import { ChannelType } from "discord.js";
import { createHash } from "node:crypto";

const TZ = "America/Chicago";
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
    key: "news",
    name: "updates-and-news",
    topic: "Latest official Sword x Staff announcements and game news, collected into one clean live board."
  }
];

let activeHub = null;

function decodeHtmlEntities(value = "") {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'",
    nbsp: " ", middot: "·", times: "×", ndash: "–", mdash: "—",
    hellip: "…", rarr: "→"
  };

  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/&([a-z0-9#]+);/gi, (full, key) => named[key.toLowerCase()] ?? full);
}

function stripHtml(value = "") {
  return decodeHtmlEntities(String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToLines(html = "") {
  return decodeHtmlEntities(String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|li|h[1-6]|button|a|tr|td|th)>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

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

function extractHtmlAnchors(html = "") {
  const anchors = [];
  const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regex.exec(html))) {
    const href = decodeHtmlEntities(match[1]);
    const label = stripHtml(match[2]);
    if (href && label) anchors.push({ href, label });
  }

  return anchors;
}

function parseHome(html) {
  const lines = htmlToLines(html);
  const seasonLine = lines.find(line => /^Season\s+\d+\s*·/i.test(line)) || "";
  const seasonMatch = seasonLine.match(/^Season\s+(\d+)\s*·\s*([^·]+?)\s*·\s*server day\s*(\d+)/i);

  const findLine = pattern => lines.find(line => pattern.test(line)) || null;
  const hunt = findLine(/^Grand Treasure Hunt\s*#/i);
  const reward = findLine(/^Level\s*5\s*:/i);
  const mini = findLine(/^(?:🎲\s*)?Mini-game\s*:/i);
  const next = findLine(/^Next\s*:/i);

  const anchors = extractHtmlAnchors(html);
  const seenNews = new Set();
  const news = [];

  for (const anchor of anchors) {
    if (!/(?:discord\.com|swordxstaff\.boltray\.com)/i.test(anchor.href)) continue;
    if (/^(?:log in|discord|see all)/i.test(anchor.label)) continue;
    const key = `${anchor.href}|${anchor.label}`;
    if (seenNews.has(key)) continue;
    seenNews.add(key);
    news.push(anchor);
    if (news.length >= 5) break;
  }

  const giftStart = lines.findIndex(line => /^Gift codes$/i.test(line) || /^🎁\s*Gift codes/i.test(line));
  const giftEnd = lines.findIndex((line, index) => index > giftStart && /Guild events/i.test(line));
  const currentCodeCandidates = (giftStart >= 0
    ? lines.slice(giftStart + 1, giftEnd > giftStart ? giftEnd : giftStart + 20)
    : [])
    .filter(line => /^[A-Z0-9]{4,30}$/.test(line));

  return {
    season: seasonMatch ? {
      number: Number(seasonMatch[1]),
      region: seasonMatch[2].trim(),
      serverDay: Number(seasonMatch[3])
    } : null,
    weekly: {
      hunt: hunt || null,
      reward: reward?.replace(/^Level\s*5\s*:\s*/i, "") || null,
      miniGame: mini?.replace(/^(?:🎲\s*)?Mini-game\s*:\s*/i, "") || null,
      next: next?.replace(/^Next\s*:\s*/i, "") || null
    },
    currentCodeCandidates,
    news
  };
}

function parseRoadmapWeek(html) {
  const lines = htmlToLines(html);
  const reset = lines.find(line => /^Both end at /i.test(line)) ||
    lines.find(line => /end at the .* reset/i.test(line)) || null;

  const comingIndex = lines.findIndex(line => /^Coming Up$/i.test(line));
  const upcoming = [];

  if (comingIndex >= 0) {
    for (const line of lines.slice(comingIndex + 1, comingIndex + 20)) {
      if (/^(?:Everything|Milestones|Events|Season All seasons)/i.test(line)) break;
      if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+[A-Z][a-z]{2}\s+\d{1,2}/.test(line)) {
        upcoming.push(line);
      }
      if (upcoming.length >= 4) break;
    }
  }

  return { reset, upcoming };
}

function parseCodes(html) {
  const lines = htmlToLines(html);
  const start = Math.max(0, lines.findIndex(line => /Copy all codes/i.test(line)) + 1);
  const codes = [];
  const seen = new Set();

  for (let i = start; i < lines.length - 1; i++) {
    const code = lines[i];
    if (!/^[A-Z0-9]{4,30}$/.test(code) || seen.has(code)) continue;

    const rewards = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
      if (/^Tap to copy$/i.test(lines[j])) break;
      if (/^[A-Z0-9]{4,30}$/.test(lines[j])) break;
      rewards.push(lines[j]);
    }

    if (!rewards.length) continue;
    seen.add(code);
    codes.push({ code, reward: rewards.join(" · ") });
  }

  return codes;
}

function parseSeasonIndex(html, currentSeasonNumber) {
  const anchors = extractHtmlAnchors(html)
    .filter(anchor => /\/seasons\/s\d+$/i.test(anchor.href));

  const parsed = anchors.map(anchor => {
    const match = anchor.label.match(
      /Season\s+(\d+)\s+(Past|Current|Upcoming)\s+(.+?)\s+Class tier\s+T(\d+)\s*·\s*(.+?)(?=\s+\d+\s+builds|$)/i
    );

    if (!match) return null;
    return {
      number: Number(match[1]),
      status: match[2],
      region: match[3].trim(),
      tier: Number(match[4]),
      dateRange: match[5].trim(),
      href: anchor.href.startsWith("http") ? anchor.href : `https://www.valkyrie.tips${anchor.href}`
    };
  }).filter(Boolean);

  const current = parsed.find(item => item.number === currentSeasonNumber) ||
    parsed.find(item => /^Current$/i.test(item.status)) || null;
  const next = current
    ? parsed.filter(item => item.number > current.number).sort((a, b) => a.number - b.number)[0] || null
    : null;

  return { current, next, all: parsed };
}

function monthIndex(shortMonth) {
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(shortMonth);
}

function parseMilestoneDate(label) {
  const match = String(label).match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+([A-Z][a-z]{2})\s+(\d{1,2})$/);
  if (!match) return null;

  const month = monthIndex(match[1]);
  if (month < 0) return null;

  const now = new Date();
  let year = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric"
  }).format(now));

  let date = new Date(Date.UTC(year, month, Number(match[2]), 12));
  if (date.getTime() < now.getTime() - 120 * 86400_000) {
    year += 1;
    date = new Date(Date.UTC(year, month, Number(match[2]), 12));
  }

  return date;
}

function parseSeasonPage(html, fallbackSeason) {
  const lines = htmlToLines(html);
  const tierLine = lines.find(line => /^T\d+\s+.+?tier list/i.test(line)) || "";
  const tierMatch = tierLine.match(/^T(\d+)\s+(.+?)\s+tier list/i);
  const tierIndex = tierLine ? lines.indexOf(tierLine) : -1;
  const classes = tierIndex >= 0 ? lines[tierIndex + 1] || null : null;

  const milestoneStart = lines.findIndex(line => /^Milestones/i.test(line));
  const milestoneEnd = lines.findIndex((line, index) => index > milestoneStart && /^Dungeon gear/i.test(line));
  const section = milestoneStart >= 0
    ? lines.slice(milestoneStart + 1, milestoneEnd > milestoneStart ? milestoneEnd : lines.length)
    : [];
  const milestones = [];

  for (let i = 0; i < section.length; i++) {
    const date = parseMilestoneDate(section[i]);
    if (!date) continue;

    const label = section[i];
    const detail = [];
    let serverDay = null;

    for (let j = i + 1; j < section.length; j++) {
      if (parseMilestoneDate(section[j])) break;
      const dayMatch = section[j].match(/^Server day\s+(\d+)/i);
      if (dayMatch) {
        serverDay = Number(dayMatch[1]);
        continue;
      }
      if (/^(?:✓\s*)?Confirmed$/i.test(section[j])) continue;
      if (/^(?:View|Full roadmap)/i.test(section[j])) continue;
      detail.push(section[j]);
    }

    milestones.push({ label, date, serverDay, detail: detail.slice(0, 5) });
  }

  return {
    seasonNumber: fallbackSeason?.number ?? null,
    tier: tierMatch ? Number(tierMatch[1]) : null,
    region: tierMatch?.[2]?.trim() || fallbackSeason?.region || null,
    classes,
    milestones
  };
}

function splitDiscordText(lines, max = 3600) {
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > max && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
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
  const codeMap = new Map(codes.map(item => [item.code, item]));

  for (const code of home.currentCodeCandidates) {
    if (!codeMap.has(code)) {
      codeMap.set(code, {
        code,
        reward: "Current code — open the live codes page for reward details."
      });
    }
  }

  return {
    fetchedAt: new Date().toISOString(),
    seasonUrl,
    home,
    season,
    seasonIndex,
    roadmapWeek,
    codes: [...codeMap.values()]
  };
}

function plainBoard(title, sections, sourceUrl, stale = false) {
  const body = [
    `**${title}**`,
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

  return { seasonal, weekly, roadmap, codes, database, builds, news };
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
    normalizeDiscordName(channel.name).includes(normalizeDiscordName(SXS_CATEGORY_MATCH))
  );

  if (!category) {
    throw new Error(`Could not find the existing ${SXS_CATEGORY_MATCH} category.`);
  }

  const resolved = {};

  for (const def of CHANNEL_DEFS) {
    let channel = guild.channels.cache.find(item =>
      item.type === ChannelType.GuildText &&
      item.parentId === category.id &&
      item.name === def.name
    );

    if (!channel) {
      channel = await guild.channels.create({
        name: def.name,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: def.topic,
        reason: "Vestra Sword x Staff live information hub"
      });
      console.log(`✅ Created SxS channel #${def.name}`);
    } else if (channel.topic !== def.topic) {
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
