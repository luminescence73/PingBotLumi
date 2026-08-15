import {
  Client,
  GatewayIntentBits,
  Partials
} from "discord.js";

import cron from "node-cron";


// ======================================================
// DISCORD CLIENT
// ======================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions
  ],

  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction
  ]
});


// ======================================================
// SETTINGS
// ======================================================

// Channel where scheduled reminder pings will be sent
const CHANNEL_ID = "1537611487768744046";

// Automatically handles CDT / CST
const TIMEZONE = "America/Chicago";


// ======================================================
// REACTION ROLE SETTINGS
// ======================================================
//
// messageId = the existing Discord message
// emoji = what members react with
// roleId = role they receive
//

const reactionRoles = {

  // 🔄 Reset
  "1537953693331361914": {
    emoji: "🔄",
    name: "Reset",
    roleId: "1537936033273086073"
  },

  // 🌅 Morning Conquest
  "1537953751120224257": {
    emoji: "🌅",
    name: "Morning Conquest",
    roleId: "1537936135114854430"
  },

  // 🌌 Night Conquest
  "1537953786713079840": {
    emoji: "🌌",
    name: "Night Conquest",
    roleId: "1537936185979183194"
  },

  // 🔔 Clash Opening Call
  "1537953911317594153": {
    emoji: "🔔",
    name: "Clash Opening Call",
    roleId: "1537936269043310752"
  },

  // ⚔️ Clash Battle Call
  "1537953981685436467": {
    emoji: "⚔️",
    name: "Clash Battle Call",
    roleId: "1537936402497675265"
  },

  // 🚨 Clash Final Call
  "1537954112488874066": {
    emoji: "🚨",
    name: "Clash Final Call",
    roleId: "1537936646442451075"
  },

  // ⏰ Guild Clash Registration
  "1537954216968982528": {
    emoji: "⏰",
    name: "Guild Clash Registration",
    roleId: "1537936738998296618"
  }

};


// ======================================================
// BOT READY
// ======================================================

client.once("ready", async () => {

  console.log(`✅ PingBot is online as ${client.user.tag}`);

  await addReactionEmojis();

  startSchedules();

});


// ======================================================
// ADD REACTIONS TO YOUR EXISTING ROLE MESSAGES
// ======================================================

async function addReactionEmojis() {

  try {

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const [messageId, settings] of Object.entries(reactionRoles)) {

      try {

        const message = await channel.messages.fetch(messageId);

        const alreadyReacted = message.reactions.cache.some(
          reaction => reaction.emoji.name === settings.emoji
        );

        if (!alreadyReacted) {
          await message.react(settings.emoji);
        }

        console.log(
          `✅ Reaction ready: ${settings.emoji} ${settings.name}`
        );

      } catch (error) {

        console.error(
          `❌ Could not access message for ${settings.name}:`,
          error
        );

      }

    }

  } catch (error) {

    console.error(
      "❌ Could not access reminder channel:",
      error
    );

  }

}


// ======================================================
// REACTION ADDED → GIVE ROLE
// ======================================================

client.on("messageReactionAdd", async (reaction, user) => {

  if (user.bot) return;

  try {

    if (reaction.partial) {
      await reaction.fetch();
    }

    const settings =
      reactionRoles[reaction.message.id];

    if (!settings) return;


    // Make sure they used the correct emoji
    if (reaction.emoji.name !== settings.emoji) {
      return;
    }


    const guild = reaction.message.guild;

    if (!guild) return;


    const member =
      await guild.members.fetch(user.id);


    await member.roles.add(settings.roleId);


    console.log(
      `✅ Added ${settings.name} to ${user.tag}`
    );

  } catch (error) {

    console.error(
      "❌ Reaction add error:",
      error
    );

  }

});


// ======================================================
// REACTION REMOVED → REMOVE ROLE
// ======================================================

client.on("messageReactionRemove", async (reaction, user) => {

  if (user.bot) return;

  try {

    if (reaction.partial) {
      await reaction.fetch();
    }

    const settings =
      reactionRoles[reaction.message.id];

    if (!settings) return;


    if (reaction.emoji.name !== settings.emoji) {
      return;
    }


    const guild = reaction.message.guild;

    if (!guild) return;


    const member =
      await guild.members.fetch(user.id);


    await member.roles.remove(settings.roleId);


    console.log(
      `✅ Removed ${settings.name} from ${user.tag}`
    );

  } catch (error) {

    console.error(
      "❌ Reaction remove error:",
      error
    );

  }

});


// ======================================================
// SEND A SCHEDULED ROLE PING
// ======================================================

async function sendPing(roleId, message) {

  try {

    const channel =
      await client.channels.fetch(CHANNEL_ID);


    await channel.send({

      content:
        `<@&${roleId}> ${message}`,

      allowedMentions: {
        roles: [roleId]
      }

    });


    console.log(
      `✅ Sent scheduled ping: ${message}`
    );

  } catch (error) {

    console.error(
      "❌ Scheduled ping error:",
      error
    );

  }

}


// ======================================================
// SCHEDULES
// ======================================================

function startSchedules() {


  // ====================================================
  // DAILY
  // ====================================================


  // 🔄 Reset
  // Every day — 8:00 AM
  cron.schedule(

    "0 8 * * *",

    () => {

      sendPing(
        "1537936033273086073",
        "Reset is starting now!"
      );

    },

    {
      timezone: TIMEZONE
    }

  );


  // 🌅 Morning Conquest
  // Every day — 11:30 AM
  cron.schedule(

    "30 11 * * *",

    () => {

      sendPing(
        "1537936135114854430",
        "Morning Conquest is starting now!"
      );

    },

    {
      timezone: TIMEZONE
    }

  );


  // 🌌 Night Conquest
  // Every day — 8:30 PM
  cron.schedule(

    "30 20 * * *",

    () => {

      sendPing(
        "1537936185979183194",
        "Night Conquest is starting now!"
      );

    },

    {
      timezone: TIMEZONE
    }

  );



  // ====================================================
  // MONDAY / WEDNESDAY / FRIDAY
  // ====================================================


  // 🔔 Clash Opening Call
  // 10:00 AM
  cron.schedule(

    "0 10 * * 1,3,5",

    () => {

      sendPing(
        "1537936269043310752",
        "Clash Opening Call!"
      );

    },

    {
      timezone: TIMEZONE
    }

  );


  // ⚔️ Clash Battle Call
  // 4:00 PM
  cron.schedule(

    "0 16 * * 1,3,5",

    () => {

      sendPing(
        "1537936402497675265",
        "Clash Battle Call!"
      );

    },

    {
      timezone: TIMEZONE
    }

  );


  // 🚨 Clash Final Call
  // 9:30 PM
  cron.schedule(

    "30 21 * * 1,3,5",

    () => {

      sendPing(
        "1537936646442451075",
        "Clash Final Call!"
      );

    },

    {
      timezone: TIMEZONE
    }

  );



  // ====================================================
  // SUNDAY / TUESDAY / THURSDAY
  // ====================================================


  // ⏰ Guild Clash Registration
  // 9:30 AM
  cron.schedule(

    "30 9 * * 0,2,4",

    () => {

      sendPing(
        "1537936738998296618",
        "Guild Clash Registration is open!"
      );

    },

    {
      timezone: TIMEZONE
    }

  );


  console.log(
    "✅ All recurring schedules are active."
  );

}


// ======================================================
// LOGIN
// ======================================================

client.login(process.env.DISCORD_BOT);