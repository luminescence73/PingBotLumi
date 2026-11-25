import test from "node:test";
import assert from "node:assert/strict";
import { MessageFlags } from "discord.js";
import { pool, getOnboardingSession } from "../src/runtime/database.js";
import { client } from "../src/runtime/client.js";
import { startOnboarding, onboardLanguage, onboardReminders, onboardPlaystyle, onboardSocial, onboardFinish } from "../src/guild/onboarding.js";
import { ASHEN_WARRIORS, ONBOARDING_COMPLETE } from "../src/guild/access.js";
import { LANGUAGE_CHANNELS, CHANNELS } from "../guildConfig.js";
import { STAFF_ROLES, PLAYSTYLE, SOCIAL, REMINDERS, TOURNAMENTS } from "../roleConfig.js";
import { conquestSecondRun, conquestSecondRunSelect } from "../src/events/staffConquest.js";
import { tournamentNext, tournamentFinish } from "../src/events/staffTournaments.js";
import { keywordAlertMatches, sendKeywordAlert } from "../src/community/keywordAlerts.js";
import { parseCodes, parseHome } from "../src/sxs/valkyrieParsers.js";

test("onboarding completes all steps, persists preferences and preserves staff roles", async t=>{
  const queries=[], added=[], removed=[], replies=[];
  t.mock.method(pool,"query",async (sql,args)=>{queries.push({sql,args});return {rows:[],rowCount:1}});
  const member={id:"test-onboard",roles:{cache:new Map([[STAFF_ROLES.ADMIN,{}],[LANGUAGE_CHANNELS.english.role,{}]]),add:async x=>added.push(...x),remove:async x=>removed.push(...x)}};
  const i={user:{id:member.id},guild:{members:{fetch:async()=>member},channels:{fetch:async()=>null}},deferReply:async x=>assert.equal(x.flags,MessageFlags.Ephemeral),deferUpdate:async()=>{},editReply:async x=>replies.push(x)};
  await startOnboarding(i);
  await onboardLanguage({...i,values:["spanish"]});
  await onboardReminders({...i,values:["reset","tournament:sever"]});
  await onboardPlaystyle({...i,values:["casual"]});
  await onboardSocial({...i,values:["chatty"]});
  assert.equal((await getOnboardingSession(member.id)).language,"spanish");
  await onboardFinish(i);
  for(const role of [ASHEN_WARRIORS,ONBOARDING_COMPLETE,LANGUAGE_CHANNELS.spanish.role,PLAYSTYLE.casual.role,SOCIAL.chatty.role,REMINDERS.reset.role,TOURNAMENTS.sever.role]) assert.ok(added.includes(role));
  assert.ok(removed.includes(LANGUAGE_CHANNELS.english.role));
  assert.ok(!removed.includes(STAFF_ROLES.ADMIN));
  assert.equal(await getOnboardingSession(member.id),null);
  assert.ok(queries.some(x=>x.sql.includes("INSERT INTO user_preferences")));
  assert.deepEqual(replies.at(-1).components,[]);
});
test("missing onboarding session cannot assign roles",async t=>{
  t.mock.method(pool,"query",async()=>({rows:[]}));
  let reply;
  await onboardFinish({user:{id:"missing-session"},deferUpdate:async()=>{},editReply:async x=>{reply=x}});
  assert.match(reply.embeds[0].toJSON().title,/Restart/);
});
test("nonstaff cannot send conquest alerts or advance or finish tournaments",async()=>{
  for(const handler of [conquestSecondRun,conquestSecondRunSelect,tournamentNext,tournamentFinish]){
    let reply;
    await handler({user:{id:"ordinary"},guild:{members:{fetch:async()=>({id:"ordinary",roles:{cache:new Map()}})}},reply:async x=>{reply=x}});
    assert.equal(reply.flags,MessageFlags.Ephemeral);
    assert.match(reply.content,/Only Ashen staff/);
  }
});
test("staff conquest menu has both runs and rejects invalid selection",async()=>{
  const replies=[];
  const i={user:{id:"owner"},guild:{members:{fetch:async()=>({id:"owner",guild:{ownerId:"owner"}})}},reply:async x=>replies.push(x)};
  await conquestSecondRun(i);
  assert.deepEqual(replies[0].components[0].toJSON().components[0].options.map(x=>x.value),["morning","night"]);
  await conquestSecondRunSelect({...i,values:["invalid"]});
  assert.match(replies[1].content,/Invalid/);
});
test("keyword detection is case insensitive, deduplicated and respects word boundaries",()=>{
  assert.deepEqual(keywordAlertMatches("HELP help Black   Knights REX"),["help","black knights","rex"]);
  assert.deepEqual(keywordAlertMatches("helpful suspicious rexford"),[]);
});
test("keyword delivery ignores bots, reserves once, sends no mentions and includes jump link",async t=>{
  const guild={id:"test-guild"}, sent=[], reserved=new Set();
  client.channels.cache.set(CHANNELS.START_HERE,{guild});
  t.after(()=>client.channels.cache.delete(CHANNELS.START_HERE));
  t.mock.method(pool,"query",async(_sql,args)=>{if(reserved.has(args[0]))return {rowCount:0};reserved.add(args[0]);return {rowCount:1}});
  t.mock.method(client.users,"fetch",async()=>({send:async x=>sent.push(x)}));
  const msg={id:"keyword-probe",guildId:guild.id,author:{id:"member",tag:"Tester"},content:"HELP",channel:{id:"channel"},channelId:"channel",url:"https://discord.com/channels/1/2/3"};
  assert.equal(await sendKeywordAlert({...msg,author:{bot:true}}),false);
  assert.equal(await sendKeywordAlert({...msg,guildId:"other"}),false);
  assert.equal(await sendKeywordAlert(msg),true);
  assert.equal(await sendKeywordAlert(msg),false);
  assert.equal(sent.length,1);
  assert.deepEqual(sent[0].allowedMentions.parse,[]);
  assert.ok(sent[0].content.includes(msg.url));
});
test("gift-code parser deduplicates codes and handles empty source",()=>{
  const html="<p>Copy all codes</p><p>TEST123</p><p>100 gems</p><p>Tap to copy</p><p>TEST123</p><p>100 gems</p><p>Tap to copy</p>";
  assert.deepEqual(parseCodes(html),[{code:"TEST123",reward:"100 gems"}]);
  assert.deepEqual(parseCodes(""),[]);
  assert.deepEqual(parseHome("<p>Gift codes</p><p>TEST123</p><p>Guild events</p>").currentCodeCandidates,["TEST123"]);
});
