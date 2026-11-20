import { dbGetState, dbSetState } from "../runtime/database.js";
import { client } from "../runtime/client.js";
import { CHANNELS, LANGUAGE_CHANNELS } from "../../guildConfig.js";
import { inferPrimaryLanguage } from "./preferences.js";
import { PLAYSTYLE, REMINDERS, SOCIAL, TOURNAMENTS } from "../../roleConfig.js";
import { BRAND_COLOR, brandEmbed } from "../shared/discord.js";
import { LANGUAGE_KEYS } from "./languages.js";
import { EmbedBuilder } from "discord.js";

export async function migrateLegacyIntroductions(force = false) {
  const completionKey = "introductions_full_rebuild_sol_v4";
  if (!force && (await dbGetState(completionKey))?.completed) {
    return { skipped: true, reason: "already_completed" };
  }

  const channel = await client.channels.fetch(CHANNELS.INTRODUCTIONS).catch(() => null);
  if (!channel?.isTextBased() || !channel.messages?.fetch) {
    return { skipped: true, reason: "introductions_channel_unavailable" };
  }

  await channel.guild.members.fetch().catch(() => {});

  const clean = value => String(value || "").replace(/\*\*/g, "").trim();
  const records = new Map();
  const vestraIntroMessages = [];
  let deleteFailures = 0;
  let rebuildFailures = 0;

  const fieldValue = (embed, label) =>
    clean((embed?.fields || []).find(field =>
      String(field.name || "").toLowerCase().includes(label)
    )?.value) || null;

  const plainValue = (content, label) => {
    const row = String(content || "").split(/\r?\n/).find(line =>
      new RegExp(label, "i").test(line)
    );
    if (!row) return null;
    return clean(row)
      .replace(/^[^A-Za-z0-9@<]*/, "")
      .replace(new RegExp(`^${label}\\s*:?\\s*`, "i"), "")
      .trim() || null;
  };

  const memberFromMessage = async message => {
    const direct = message.mentions?.members?.first?.();
    if (direct) return direct;

    const id = message.content?.match(/<@!?(\d+)>/)?.[1];
    if (id) {
      const fetched = await channel.guild.members.fetch(id).catch(() => null);
      if (fetched) return fetched;
    }

    const candidates = [];
    for (const embed of message.embeds || []) {
      const desc = clean(embed.description);
      const title = clean(embed.title);
      const fromDesc = desc.match(/^(.+?)\s+has completed/i)?.[1];
      const fromTitle =
        title.match(/welcome\s+(.+?)(?:!|$)/i)?.[1] ||
        title.match(/new ashen warrior.*?([A-Za-z0-9_.\-]+)/i)?.[1];
      if (fromDesc) candidates.push(fromDesc);
      if (fromTitle) candidates.push(fromTitle);
    }

    const plainWelcome = clean(message.content).match(/welcome\s+@?([^!\n]+)/i)?.[1];
    if (plainWelcome) candidates.push(plainWelcome);

    for (const raw of candidates) {
      const target = raw.replace(/^@/, "").trim().toLowerCase();
      const member = channel.guild.members.cache.find(m =>
        m.displayName.toLowerCase() === target ||
        m.user.username.toLowerCase() === target ||
        m.user.globalName?.toLowerCase() === target
      );
      if (member) return member;
    }

    return null;
  };

  // Read the whole channel first so nothing is lost before deletion.
  let before;
  while (true) {
    const page = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    }).catch(() => null);

    if (!page?.size) break;

    for (const message of page.values()) {
      const combined = [
        message.content || "",
        ...(message.embeds || []).flatMap(embed => [
          embed.title || "",
          embed.description || "",
          ...(embed.fields || []).flatMap(field => [field.name || "", field.value || ""])
        ])
      ].join("\n");

      const isGuide =
        /new members enter here/i.test(combined) ||
        /vestra announces completed inductions/i.test(combined) ||
        (
          /ashen\s*[\/|]\s*introductions/i.test(combined) &&
          /welcome new recruits|new members/i.test(combined)
        );

      const hasThreeFields =
        /language/i.test(combined) &&
        /playstyle/i.test(combined) &&
        /social/i.test(combined);

      const isRecruit =
        !isGuide &&
        (
          /new recruit/i.test(combined) ||
          /new ashen warrior/i.test(combined) ||
          /welcome\s+/i.test(combined) ||
          hasThreeFields
        );

      if (!isGuide && !isRecruit) continue;

      const isCurrentVestra = message.author.id === client.user.id;
      const isBotLike = message.author.bot || !!message.webhookId;
      if (!isCurrentVestra && !isBotLike) continue;

      vestraIntroMessages.push(message);
      if (!isRecruit) continue;

      const member = await memberFromMessage(message);
      const embed = (message.embeds || []).find(e => {
        const text = [e.title || "", e.description || "", ...(e.fields || []).map(f => f.name || "")].join(" ");
        return /new recruit|new ashen warrior|welcome|language|playstyle|social/i.test(text);
      }) || null;

      const memberId = member?.id || message.content?.match(/<@!?(\d+)>/)?.[1] || null;
      const displayName =
        member?.displayName ||
        clean(embed?.description).match(/^(.+?)\s+has completed/i)?.[1] ||
        clean(embed?.title).match(/welcome\s+(.+?)(?:!|$)/i)?.[1] ||
        "Former Member";

      const avatarURL =
        member?.user?.displayAvatarURL?.({ size: 256 }) ||
        embed?.thumbnail?.url ||
        null;

      const language =
        member
          ? LANGUAGE_CHANNELS[await inferPrimaryLanguage(member)]?.name
          : null;
      const playstyle =
        member
          ? Object.values(PLAYSTYLE).find(item => member.roles.cache.has(item.role))?.name
          : null;
      const social =
        member
          ? Object.values(SOCIAL).find(item => member.roles.cache.has(item.role))?.name
          : null;

      const sourceLanguage =
        fieldValue(embed, "language") ||
        plainValue(message.content, "language") ||
        "Not specified";
      const sourcePlaystyle =
        fieldValue(embed, "playstyle") ||
        plainValue(message.content, "playstyle") ||
        "Not specified";
      const sourceSocial =
        fieldValue(embed, "social") ||
        plainValue(message.content, "social") ||
        "Not specified";

      // If we cannot identify a member ID, use the normalized display name to
      // still dedupe repeated historic cards for the same former member.
      const key = memberId || `name:${displayName.toLowerCase()}`;
      const existing = records.get(key);

      const candidate = {
        member,
        memberId,
        displayName,
        avatarURL,
        language: language || sourceLanguage,
        playstyle: playstyle || sourcePlaystyle,
        social: social || sourceSocial,
        firstTimestamp: existing
          ? Math.min(existing.firstTimestamp, message.createdTimestamp)
          : message.createdTimestamp,
        latestTimestamp: message.createdTimestamp
      };

      // Current role data wins for active members; otherwise use the newest
      // historic card while preserving the person's earliest intro date.
      if (!existing || message.createdTimestamp >= existing.latestTimestamp || member) {
        records.set(key, {
          ...candidate,
          firstTimestamp: existing
            ? Math.min(existing.firstTimestamp, message.createdTimestamp)
            : message.createdTimestamp
        });
      }
    }

    before = page.last()?.id;
    if (!before || page.size < 100) break;
  }

  // Remove every old Vestra guide/recruit message so there can be no replicas.
  for (const message of vestraIntroMessages) {
    await message.delete().catch(error => {
      deleteFailures++;
      console.warn(`⚠️ Could not delete old introduction ${message.id}: ${error.message}`);
    });
  }

  // Post the guide FIRST so it is physically above every rebuilt Vestra card.
  const guideContent = `# ✦ ASHEN / INTRODUCTIONS
**New members enter here.**

Vestra announces completed inductions with each member's language, playstyle, and social preference.

Welcome new recruits. Make them part of the guild.`;

  const guide = await channel.send({
    content: guideContent,
    embeds: [],
    allowedMentions: { parse: [] }
  });

  await guide.pin("Keep the Ashen introductions guide easy to find").catch(() => {});
  await dbSetState("panel_introductions", { messageId: guide.id });

  const ordered = [...records.values()].sort(
    (a, b) => a.firstTimestamp - b.firstTimestamp
  );

  let rebuilt = 0;
  for (const record of ordered) {
    const card = welcomeCardFromData(
      record.displayName,
      record.avatarURL,
      record.language,
      record.playstyle,
      record.social,
      new Date(record.firstTimestamp)
    );

    await channel.send({
      content: record.memberId ? `<@${record.memberId}>` : `**${record.displayName}**`,
      embeds: [card],
      allowedMentions: { parse: [] }
    }).then(() => {
      rebuilt++;
    }).catch(error => {
      rebuildFailures++;
      console.error(`❌ Could not rebuild intro for ${record.displayName}: ${error.message}`);
    });
  }

  const succeeded = deleteFailures === 0 && rebuildFailures === 0;

  if (succeeded) {
    await dbSetState(completionKey, {
      completed: true,
      oldMessagesRemoved: vestraIntroMessages.length,
      uniqueCardsRebuilt: rebuilt
    });
  }

  const summary = {
    succeeded,
    scannedIntroMessages: vestraIntroMessages.length,
    removed: vestraIntroMessages.length - deleteFailures,
    deleteFailures,
    rebuilt,
    rebuildFailures,
    uniqueRecords: records.size
  };

  console.log(
    `${succeeded ? "✅" : "⚠️"} Introductions rebuild v4: ${summary.removed} old intro message(s) removed, ${deleteFailures} delete failure(s), ${rebuilt} unique recruit card(s) recreated, ${rebuildFailures} rebuild failure(s).`
  );

  return summary;
}

function welcomeCardFromData(displayName, avatarURL, languageName, playstyleName, socialName, timestamp = new Date()) {
  const card = brandEmbed(
    "ASHEN | NEW RECRUIT",
    `**${displayName}** has completed induction and joined the ranks.`
  )
    .addFields(
      { name: "Language", value: languageName || "Not specified", inline: true },
      { name: "Playstyle", value: playstyleName || "Not specified", inline: true },
      { name: "Social", value: socialName || "Not specified", inline: true }
    )
    .setFooter({ text: "Vestra | Ashen Roster" })
    .setTimestamp(timestamp);

  if (avatarURL) card.setThumbnail(avatarURL);
  return card;
}

function welcomeCard(member, languageName, playstyleName, socialName, timestamp = new Date()) {
  return welcomeCardFromData(
    member.displayName,
    member.user.displayAvatarURL({ size: 256 }),
    languageName,
    playstyleName,
    socialName,
    timestamp
  );
}

export async function upsertRecruitIntroduction(channel, member, languageName, playstyleName, socialName) {
  let before;
  const matches = [];

  const belongsToMember = message => {
    if (message.author.id !== client.user.id) return false;

    const isRecruitCard = message.embeds?.some(embed =>
      /ASHEN\s*\|\s*NEW RECRUIT/i.test(embed.title || "")
    );
    if (!isRecruitCard) return false;

    // Match either Discord mention syntax (<@id> or <@!id>).
    const mentionedId = message.content?.match(/<@!?(\d+)>/)?.[1];
    if (mentionedId) return mentionedId === member.id;

    // Fallback for older cards that only stored the member name in the embed.
    return message.embeds?.some(embed => {
      const description = String(embed.description || "")
        .replace(/\*\*/g, "")
        .trim()
        .toLowerCase();

      return (
        description.startsWith(member.displayName.toLowerCase() + " has completed") ||
        description.startsWith(member.user.username.toLowerCase() + " has completed") ||
        (
          member.user.globalName &&
          description.startsWith(member.user.globalName.toLowerCase() + " has completed")
        )
      );
    });
  };

  while (true) {
    const page = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    });

    if (!page.size) break;

    for (const message of page.values()) {
      if (belongsToMember(message)) matches.push(message);
    }

    before = page.last()?.id;
    if (!before || page.size < 100) break;
  }

  // Keep the oldest card so repeat onboarding never changes the member's
  // original introduction position/date more than necessary.
  matches.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const existing = matches[0] || null;

  const timestamp = existing?.createdAt || new Date();
  const payload = {
    content: `<@${member.id}>`,
    embeds: [
      welcomeCard(
        member,
        languageName,
        playstyleName,
        socialName,
        timestamp
      )
    ],
    allowedMentions: { parse: [] }
  };

  let canonical;
  if (existing) {
    canonical = await existing.edit(payload);

    // Remove every duplicate recruit card for this same member.
    for (const duplicate of matches.slice(1)) {
      await duplicate.delete().catch(error =>
        console.warn(
          `⚠️ Could not delete duplicate recruit card ${duplicate.id} for ${member.id}: ${error.message}`
        )
      );
    }
  } else {
    canonical = await channel.send(payload);
  }

  return canonical;
}

export async function memberCardEmbed(member) {
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
    .setTitle(`✦ ASHEN | ${member.displayName}`)
    .setDescription(`✧ ${LANGUAGE_CHANNELS[primary].name} · ${playstyle} · ${social}`)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "🌐 Notification language", value: LANGUAGE_CHANNELS[primary].name },
      { name: "✧ Language access", value: languageAccess.join(", ") || "None" },
      { name: "⚔ Playstyle", value: playstyle, inline: true },
      { name: "💬 Social", value: social, inline: true },
      { name: "🔔 Guild alerts", value: reminders.join(", ") || "None" },
      { name: "🏆 Tournament alerts", value: tournaments.join(", ") || "None" }
    )
    .setFooter({ text: "✦ Vestra | Ashen Profile" });
}
