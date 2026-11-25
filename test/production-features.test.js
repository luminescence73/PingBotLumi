import test from "node:test";
import assert from "node:assert/strict";
import { MessageFlags, GatewayIntentBits } from "discord.js";
import { client } from "../src/runtime/client.js";
import { LANGUAGE_CHANNELS } from "../guildConfig.js";
import { STAFF_ROLES } from "../roleConfig.js";
import { isStaff, PROTECTED_ROLES, RESETTABLE_ROLES, SOCIAL_CATEGORY_ID } from "../src/guild/access.js";
import { inferPrimaryFromRoles } from "../src/guild/preferences.js";
import { googleTranslate, hasTranslatableText } from "../src/translation/google.js";
import { handleSocialTranslationButton, isReactionTranslateChannel, handleSocialTranslationReaction } from "../src/translation/social.js";
import { SCHEDULED_EVENTS, eventApplies, eventTimeForDate, chicagoParts, dateKey } from "../src/events/schedule.js";
import { pool } from "../src/runtime/database.js";

test("gateway has member, message and reaction intents", () => {
  for (const bit of [GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.MessageContent]) assert.ok(client.options.intents.has(bit));
});
test("staff authorization and protected roles", () => {
  const member = {id:"member",guild:{ownerId:"owner",roles:{cache:new Map()}},roles:{cache:new Map()}};
  assert.equal(isStaff(member),false);
  assert.equal(isStaff({...member,id:"owner"}),true);
  for (const role of [STAFF_ROLES.ADMIN,STAFF_ROLES.LEADER,STAFF_ROLES.DEPUTY,STAFF_ROLES.OFFICERS]) {
    assert.equal(isStaff({...member,roles:{cache:new Map([[role,{}]])}}),true);
    assert.ok(PROTECTED_ROLES.has(role));
    assert.ok(!RESETTABLE_ROLES.has(role));
  }
});
test("primary language preference wins over multiple language roles", () => {
  const member={id:"member",roles:{cache:new Map(Object.values(LANGUAGE_CHANNELS).map(x=>[x.role,{}]))}};
  assert.equal(inferPrimaryFromRoles(member,new Map([["member","spanish"]])),"spanish");
  assert.equal(inferPrimaryFromRoles(member,new Map()),"english");
});
test("reaction translations exclude automatic language channels and nontext channels", () => {
  for(const info of Object.values(LANGUAGE_CHANNELS)) assert.equal(isReactionTranslateChannel({id:info.channel,parentId:SOCIAL_CATEGORY_ID,isTextBased:()=>true}),false);
  assert.equal(isReactionTranslateChannel({id:"social",parentId:SOCIAL_CATEGORY_ID,isTextBased:()=>true}),true);
  assert.equal(isReactionTranslateChannel({isTextBased:()=>false}),false);
});
test("expired translation button replies privately and unrelated button is ignored", async () => {
  const replies=[];
  const interaction={isButton:()=>true,customId:"vestra_translate:missing:member",reply:async x=>replies.push(x)};
  assert.equal(await handleSocialTranslationButton(interaction),true);
  assert.equal(replies[0].flags,MessageFlags.Ephemeral);
  assert.equal(await handleSocialTranslationButton({...interaction,customId:"settings_open"}),false);
});
test("reaction button is requester-bound and private even when another member clicks", async t => {
  t.mock.method(globalThis,"setTimeout",()=>({}));
  t.mock.method(globalThis,"clearTimeout",()=>{});
  const replies=[];
  const message={id:"probe",guild:{members:{me:{}}},channel:{id:"social",parentId:SOCIAL_CATEGORY_ID,isTextBased:()=>true,permissionsFor:()=>({has:()=>false})},reply:async x=>{replies.push(x);return {delete:async()=>{}}}};
  const reaction={message,emoji:{name:"🌐"}};
  assert.equal(await handleSocialTranslationReaction(reaction,{id:"requester"}),true);
  assert.equal(await handleSocialTranslationReaction(reaction,{id:"requester"}),true);
  assert.equal(replies.length,1);
  const id=replies[0].components[0].toJSON().components[0].custom_id;
  assert.equal(id,"vestra_translate:probe:requester");
  const denied=[];
  await handleSocialTranslationButton({isButton:()=>true,customId:id,user:{id:"other"},reply:async x=>denied.push(x)});
  assert.equal(denied[0].flags,MessageFlags.Ephemeral);
  const deferred=[],edited=[];
  t.mock.method(pool,"query",async()=>({rows:[{primary_language:"spanish"}]}));
  t.mock.method(globalThis,"fetch",async()=>({ok:true,json:async()=>({data:{translations:[{translatedText:"Hola"}]}})}));
  await handleSocialTranslationButton({isButton:()=>true,customId:id,user:{id:"requester"},deferReply:async x=>deferred.push(x),message:{delete:async()=>{}},channel:{messages:{fetch:async()=>({content:"Private probe",author:{username:"Tester",displayAvatarURL:()=>"https://example.com/avatar.png"}})}},guild:{members:{fetch:async()=>({id:"requester"})}},editReply:async x=>edited.push(x)});
  assert.equal(deferred[0].flags,MessageFlags.Ephemeral);
  assert.equal(edited[0].embeds[0].toJSON().description,"Hola");
});
test("translation preserves Discord mentions, URLs, code and emoji and caches results", async t => {
  let calls=0;
  t.mock.method(globalThis,"fetch",async (_url,options)=>{calls++;const q=JSON.parse(options.body).q;assert.ok(!q.includes("@everyone"));return {ok:true,json:async()=>({data:{translations:[{translatedText:q.replace("Hello","Hola")}]}})}});
  const original="Hello @everyone <@123> <:wave:123> https://example.com `code`";
  assert.equal(await googleTranslate(original,"es"),original.replace("Hello","Hola"));
  assert.equal(await googleTranslate(original,"es"),original.replace("Hello","Hola"));
  assert.equal(calls,1);
  assert.equal(hasTranslatableText("https://example.com <:wave:123>"),false);
});
test("all scheduled events have unique keys, valid times and valid weekdays",()=>{
  assert.equal(new Set(SCHEDULED_EVENTS.map(e=>e.key)).size,SCHEDULED_EVENTS.length);
  for(const e of SCHEDULED_EVENTS) {
    for(const [h,m] of [e.winter,e.summer]) assert.ok(h>=0&&h<24&&m>=0&&m<60);
    for(let day=0;day<7;day++) if(!e.days.includes(day)) assert.equal(eventApplies(e,2026,11,24,day),false);
    assert.deepEqual(eventTimeForDate(e,2026,1,15),e.winter);
    assert.deepEqual(eventTimeForDate(e,2026,7,15),e.summer);
  }
});
test("Nexus and Chaos alternate Sundays; Central clock handles DST",()=>{
  const nexus=SCHEDULED_EVENTS.find(e=>e.key==="nexus_tournament_start");
  const chaos=SCHEDULED_EVENTS.find(e=>e.key==="chaos_tyrant_last_call");
  for(const [day,expected] of [[8,true],[15,false],[22,true],[29,false]]) {
    assert.equal(eventApplies(nexus,2026,11,day,0),expected);
    assert.equal(eventApplies(chaos,2026,11,day,0),!expected);
  }
  assert.equal(chicagoParts(new Date("2026-01-15T14:00:00Z")).hour,8);
  assert.equal(chicagoParts(new Date("2026-07-15T14:00:00Z")).hour,9);
  assert.equal(dateKey({year:2026,month:1,day:2}),"2026-01-02");
});
