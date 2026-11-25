import { ChannelType, PermissionFlagsBits } from "discord.js";
export async function runDiagnostics(client, guild, pool) {
  const results = [];
  const check = async (name, fn) => {
    try { results.push((await fn() ? "PASS" : "FAIL") + " | " + name); }
    catch { results.push("FAIL | " + name); }
  };
  await check("Gateway", () => client.isReady());
  await check("Database", async () => (await pool.query("SELECT 1 AS probe")).rows[0].probe === 1);
  let channel, me;
  const privateChannel = ch => ch?.type === ChannelType.GuildText && ch.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) === false;
  await check("Private test channel", async () => {
    if (!guild) return false;
    me = await guild.members.fetchMe();
    const channels = await guild.channels.fetch();
    channel = channels.find(c => c?.name === "vestra-test");
    if (!channel) channel = await guild.channels.create({name:"vestra-test",type:ChannelType.GuildText,permissionOverwrites:[
      {id:guild.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]},
      {id:me.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]}
    ],reason:"Private Vestra diagnostics"});
    return privateChannel(channel) && me.permissionsIn(channel).has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]);
  });
  await check("Live message round trip", async () => {
    if (!privateChannel(channel)) return false;
    const msg = await channel.send({content:"Vestra diagnostic probe",allowedMentions:{parse:[]}});
    try { return (await channel.messages.fetch({message:msg.id,force:true})).content === "Vestra diagnostic probe"; }
    finally { await msg.delete(); }
  });
  console.log("Vestra diagnostics\n"+results.join("\n")+"\nNOT_TESTED | Human member interactions");
}
