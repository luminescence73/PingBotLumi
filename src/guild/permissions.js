import {
  ASHEN_WARRIORS,
  LANGUAGES,
  ONBOARDING_COMPLETE,
  commandStaffRoleIds,
  getGuild,
  resolveAshenGuild
} from "./access.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { CHANNELS, LANGUAGE_CHANNELS } from "../../guildConfig.js";
import { client } from "../runtime/client.js";
import { isReactionTranslateChannel } from "../translation/social.js";
import { PLAYSTYLE, REMINDERS, SOCIAL, TOURNAMENTS } from "../../roleConfig.js";

export async function applyAshenPermissions(guildOverride = null) {
  const guild = await resolveAshenGuild(guildOverride);
  if (!guild) return;

  await Promise.all([
    guild.channels.fetch().catch(() => null),
    guild.roles.fetch().catch(() => null)
  ]);

  const norm = value => String(value || "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/^[^A-Z0-9]+/, "")
    .replace(/[^A-Z0-9]+/g, "");

  const category = label => guild.channels.cache.find(ch =>
    ch.type === ChannelType.GuildCategory &&
    norm(ch.name) === norm(label)
  ) || null;

  const textChannel = name => guild.channels.cache.find(ch =>
    ch.type === ChannelType.GuildText &&
    (
      ch.name === name ||
      norm(ch.name).endsWith(norm(name))
    )
  ) || null;

  const voiceChannel = name => guild.channels.cache.find(ch =>
    ch.type === ChannelType.GuildVoice &&
    ch.name.toLowerCase() === name.toLowerCase()
  ) || null;

  const welcome = category("✧ ASHEN | WELCOME");
  const commons = category("◇ ASHEN | COMMONS");
  const sxsGuild = category("✦ SWORD X STAFF | GUILD");
  const intel = category("✧ SWORD X STAFF | INTEL");
  const community = category("◇ ASHEN | COMMUNITY");
  const command = category("⚔ ASHEN | COMMAND");
  const voice = category("⌁ ASHEN | VOICE");

  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  const staffRoleIds = commandStaffRoleIds(guild);
  const staffRoles = staffRoleIds
    .map(id => guild.roles.cache.get(id))
    .filter(Boolean);

  const safeEdit = async (channel, target, permissions, reason) => {
    if (!channel || !target) return;
    await channel.permissionOverwrites.edit(target, permissions, { reason })
      .catch(error => console.error(`❌ Permission ${channel.name}: ${error.message}`));
  };

  const syncChildren = async (parent, excludeNames = []) => {
    if (!parent) return;
    const excluded = new Set(excludeNames.map(norm));
    for (const channel of guild.channels.cache.values()) {
      if (channel.parentId !== parent.id) continue;
      if (excluded.has(norm(channel.name))) continue;
      await channel.lockPermissions().catch(error =>
        console.error(`❌ Could not sync #${channel.name}: ${error.message}`)
      );
    }
  };

  const staffAllowText = {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AddReactions: true,
    CreatePublicThreads: true,
    CreatePrivateThreads: true,
    SendMessagesInThreads: true
  };

  const staffAllowVoice = {
    ViewChannel: true,
    Connect: true,
    Speak: true
  };

  // Before onboarding: only Welcome is visible.
  if (welcome) {
    await safeEdit(welcome, guild.roles.everyone, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false
    }, "Ashen onboarding visibility");

    await safeEdit(welcome, ONBOARDING_COMPLETE, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false
    }, "Ashen onboarding visibility");

    for (const role of staffRoles) {
      await safeEdit(welcome, role, staffAllowText, "Ashen staff access");
    }
    if (me) await safeEdit(welcome, me, staffAllowText, "Vestra access");
  }

  // Public categories unlock only after onboarding is complete.
  for (const publicCategory of [commons, sxsGuild, intel, community]) {
    if (!publicCategory) continue;

    await safeEdit(publicCategory, guild.roles.everyone, {
      ViewChannel: false
    }, "Require completed onboarding");

    await safeEdit(publicCategory, ONBOARDING_COMPLETE, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: publicCategory === commons
    }, "Completed onboarding access");

    for (const role of staffRoles) {
      await safeEdit(publicCategory, role, staffAllowText, "Ashen staff access");
    }
    if (me) await safeEdit(publicCategory, me, staffAllowText, "Vestra access");
  }

  // Clear stale legacy channel overrides before adding the intentional exceptions below.
  await syncChildren(welcome);
  await syncChildren(commons);
  await syncChildren(sxsGuild, Object.values(LANGUAGE_CHANNELS).map(info =>
    guild.channels.cache.get(info.channel)?.name
  ).filter(Boolean));
  await syncChildren(intel);
  await syncChildren(community);
  await syncChildren(voice, ["Command"]);

  // Welcome is mostly read-only. Introductions becomes conversational after onboarding.
  for (const name of ["start-here", "announcements", "server-guide", "onboarding", "vestra-settings"]) {
    const channel = textChannel(name);
    if (!channel) continue;
    await safeEdit(channel, guild.roles.everyone, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false
    }, "Welcome information is read-only");
    await safeEdit(channel, ONBOARDING_COMPLETE, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false
    }, "Welcome information is read-only");
  }

  const introductions = textChannel("introductions");
  if (introductions) {
    await safeEdit(introductions, guild.roles.everyone, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false
    }, "Introductions available after onboarding");
    await safeEdit(introductions, ONBOARDING_COMPLETE, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
      AddReactions: true
    }, "Introductions available after onboarding");
    if (me) {
      await safeEdit(introductions, me, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
        ManageMessages: true,
        ManageThreads: true,
        EmbedLinks: true
      }, "Allow Vestra to rebuild and deduplicate introductions");
    }
  }

  const settings = textChannel("vestra-settings");
  if (settings) {
    await safeEdit(settings, ONBOARDING_COMPLETE, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      AddReactions: true
    }, "Allow Vestra settings reactions");
  }

  // Sword x Staff Guild: event information is read-only; social/share channels allow replies.
  for (const name of ["sxs-event-board", "war-board", "guild-pings"]) {
    const channel = textChannel(name);
    if (!channel) continue;
    await safeEdit(channel, ONBOARDING_COMPLETE, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false
    }, "SxS operation board is read-only");
  }

  const sxsMedia = textChannel("sxs-media");
  if (sxsMedia) {
    await safeEdit(sxsMedia, ONBOARDING_COMPLETE, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
      AddReactions: true
    }, "SxS member sharing");
  }

  // Each General language stays visible only to members who selected that language.
  for (const info of Object.values(LANGUAGE_CHANNELS)) {
    const channel = guild.channels.cache.get(info.channel);
    const languageRole = guild.roles.cache.get(info.role);
    if (!channel?.isTextBased?.() || !languageRole) continue;

    await safeEdit(channel, guild.roles.everyone, {
      ViewChannel: false
    }, "Language-specific General");
    await safeEdit(channel, ONBOARDING_COMPLETE, {
      ViewChannel: false
    }, "Language-specific General");
    await safeEdit(channel, languageRole, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
      AddReactions: true,
      SendMessagesInThreads: true
    }, "Selected language access");
  }

  // Intel is read-only except Spare Ingredients, which is a member sharing channel.
  if (intel) {
    await safeEdit(intel, ONBOARDING_COMPLETE, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false
    }, "SxS Intel is read-only");
  }

  const spareIngredients = textChannel("spare-ingredients");
  if (spareIngredients) {
    await safeEdit(spareIngredients, ONBOARDING_COMPLETE, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
      AddReactions: true
    }, "Allow members to share spare ingredients");
  }

  // Community: only Suggestions is an open-feed chat channel.
  const highlights = textChannel("highlights");
  if (highlights) {
    await safeEdit(highlights, ONBOARDING_COMPLETE, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      AddReactions: true
    }, "Highlights are read-only");
  }

  const showcase = textChannel("community-highlights");
  if (showcase) {
    await safeEdit(showcase, guild.roles.everyone, {
      ViewChannel: false,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false
    }, "Showcase requires onboarding");
    await safeEdit(showcase, ONBOARDING_COMPLETE, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      AddReactions: true,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: true
    }, "Members may react and discuss showcase posts");
  }

  const suggestions = textChannel("suggestions");
  if (suggestions) {
    await safeEdit(suggestions, ONBOARDING_COMPLETE, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
      AddReactions: true
    }, "Suggestions are open to onboarded members");
  }

  const help = textChannel("help-and-requests");
  if (help) {
    await safeEdit(help, ONBOARDING_COMPLETE, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: true
    }, "Help Center uses Vestra buttons and threads");
  }

  // Command is exact staff-only access: Officers, Deputy, Leader, Admin,
  // Temp Owner(s), the Discord server owner, and Vestra.
  if (command) {
    const overwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      },
      {
        id: ONBOARDING_COMPLETE,
        deny: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      },
      ...staffRoles.map(role => ({
        id: role.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.CreatePrivateThreads,
          PermissionFlagsBits.SendMessagesInThreads
        ]
      }))
    ];

    if (me) {
      overwrites.push({
        id: me.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.ManageThreads
        ]
      });
    }

    await command.permissionOverwrites.set(
      overwrites,
      "Ashen Command is private to approved staff roles"
    ).catch(error => console.error("❌ Command permissions:", error.message));

    for (const channel of guild.channels.cache.values()) {
      if (channel.parentId !== command.id) continue;
      await channel.lockPermissions().catch(error =>
        console.error(`❌ Could not lock #${channel.name} to Command: ${error.message}`)
      );
    }
  }

  // Voice unlocks after onboarding; the Command voice room remains staff-only.
  if (voice) {
    await safeEdit(voice, guild.roles.everyone, {
      ViewChannel: false,
      Connect: false
    }, "Require completed onboarding for voice");
    await safeEdit(voice, ONBOARDING_COMPLETE, {
      ViewChannel: true,
      Connect: true,
      Speak: true
    }, "Completed onboarding voice access");
    for (const role of staffRoles) {
      await safeEdit(voice, role, staffAllowVoice, "Ashen staff voice access");
    }
    if (me) await safeEdit(voice, me, staffAllowVoice, "Vestra voice access");
  }

  const commandVoice = voiceChannel("Command");
  if (commandVoice) {
    const overwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
      },
      {
        id: ONBOARDING_COMPLETE,
        deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
      },
      ...staffRoles.map(role => ({
        id: role.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak
        ]
      }))
    ];
    if (me) {
      overwrites.push({
        id: me.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
      });
    }
    await commandVoice.permissionOverwrites.set(
      overwrites,
      "Private Ashen staff voice room"
    ).catch(error => console.error("❌ Command voice permissions:", error.message));
  }

  console.log("✅ Ashen permission model applied.");
}

async function checkChannelPermissions(channelId, label, required) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.error(`❌ ${label}: Channel unavailable`);
    return;
  }
  const guild = channel.guild;
  const me = guild.members.me || await guild.members.fetchMe();
  const permissions = channel.permissionsFor(me);
  const missing = required.filter(permission => !permissions?.has(permission.flag)).map(permission => permission.name);
  if (missing.length) console.error(`❌ ${label}: Missing ${missing.join(", ")}`);
  else console.log(`✅ ${label}: Permissions OK`);
}

export async function runPermissionChecks() {
  const basic = [
    { name: "View Channel", flag: PermissionFlagsBits.ViewChannel },
    { name: "Send Messages", flag: PermissionFlagsBits.SendMessages },
    { name: "Read Message History", flag: PermissionFlagsBits.ReadMessageHistory }
  ];
  const webhook = [...basic, { name: "Manage Webhooks", flag: PermissionFlagsBits.ManageWebhooks }];

  await checkChannelPermissions(CHANNELS.REMINDERS, "#guild-pings", basic);
  await checkChannelPermissions(CHANNELS.PREFERENCES, "#preferences", [...basic, { name: "Add Reactions", flag: PermissionFlagsBits.AddReactions }]);
  await checkChannelPermissions(CHANNELS.HELP, "#help", basic);
  await checkChannelPermissions(
    CHANNELS.INTRODUCTIONS,
    "#introductions cleanup",
    [
      ...basic,
      { name: "Manage Messages", flag: PermissionFlagsBits.ManageMessages }
    ]
  );
  await checkChannelPermissions(CHANNELS.EVENT_BOARD, "Live Event Board", basic);
  await checkChannelPermissions(CHANNELS.HIGHLIGHTS, "Community Highlights", basic);

  for (const info of Object.values(LANGUAGE_CHANNELS)) {
    await checkChannelPermissions(info.channel, `${info.name} General`, webhook);
  }

  const guild = getGuild();
  if (guild) {
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (me?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
      console.log("✅ Server: Manage Channels OK");
    } else {
      console.error("❌ Server: Missing Manage Channels");
    }
    const reactionTranslatePermissions = [
      ...basic,
      { name: "Manage Messages", flag: PermissionFlagsBits.ManageMessages }
    ];

    const reactionTranslateChannels = guild.channels.cache.filter(
      channel => isReactionTranslateChannel(channel)
    );

    console.log(`🌐 Translation audit: checking ${reactionTranslateChannels.size} supported text channel(s).`);

    for (const channel of reactionTranslateChannels.values()) {
      await checkChannelPermissions(
        channel.id,
        `🌐 Translate #${channel.name}`,
        reactionTranslatePermissions
      );
    }

    if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      console.error("❌ Server: Vestra is missing Manage Roles");
    } else {
      console.log("✅ Server: Manage Roles OK");
      const managedRoleIds = new Set([
        ASHEN_WARRIORS, ONBOARDING_COMPLETE,
        ...Object.values(LANGUAGES).map(x => x.role),
        ...Object.values(PLAYSTYLE).map(x => x.role),
        ...Object.values(SOCIAL).map(x => x.role),
        ...Object.values(REMINDERS).map(x => x.role),
        ...Object.values(TOURNAMENTS).map(x => x.role)
      ]);
      const tooHigh = guild.roles.cache
        .filter(role => managedRoleIds.has(role.id) && role.position >= me.roles.highest.position)
        .map(role => role.name);
      if (tooHigh.length) console.error(`❌ Role hierarchy: move Vestra above ${tooHigh.join(", ")}`);
      else console.log("✅ Role hierarchy: Vestra can manage all community roles");
    }
  }

  console.log("✅ Startup permission audit finished.");
}
