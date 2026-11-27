import { createHash } from "node:crypto";

const GOOGLE_TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2";

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

  // Preserve Discord broadcast mentions as literal mentions across translations.
  protect(/@(everyone|here)\b/g);
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
    // Google may alter case or insert whitespace into placeholder tokens.
    const flexible = item.token.split("").join("\\s*");
    text = text.replace(new RegExp(flexible, "gi"), () => item.original);
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

export function hasTranslatableText(input) {
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

export async function googleTranslate(text, targetCode, sourceCode = null) {
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

  let restored = restoreDiscordContent(decodeGoogleText(translated), protectedMessage.replacements);
  // Recover emoji shorthand if the provider or Discord strips the markup.
  const emojis = new Map();
  for (const match of text.matchAll(/<a?:([A-Za-z0-9_]+):\d+>/g)) {
    if (!emojis.has(match[1])) emojis.set(match[1], match[0]);
    else if (emojis.get(match[1]) !== match[0]) emojis.set(match[1], null);
  }
  restored = restored.replace(/<a?:[A-Za-z0-9_]+:\d+>|:([A-Za-z0-9_]+):/g, (match, name) => emojis.get(name) || match);
  translationCache.set(key, { text: restored, time: Date.now() });

  if (translationCache.size > 2000) {
    const first = translationCache.keys().next().value;
    if (first) translationCache.delete(first);
  }

  return restored;
}
