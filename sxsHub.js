import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder
} from "discord.js";
import { createHash } from "node:crypto";

const TZ = "America/Chicago";
const BRAND_COLOR = 0x363B41;
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
      if (/^(?:Mon|Tue|Wed|Thu|Fri|S