import test from "node:test";
import assert from "node:assert/strict";
import { Collection } from "discord.js";
import { client } from "../src/runtime/client.js";
import { pool } from "../src/runtime/database.js";
import { CHANNELS, LANGUAGE_CHANNELS } from "../guildConfig.js";
import { sendLocalizedRoleNotification } from "../src/events/notifications.js";

for(const fail of [false,true]) test("localized delivery "+(fail?"fails closed":"pings each primary cohort once"),async t=>{
 const sent=[], changes=[];
 const members=new Collection();
 for(const id of ["a","b"]){
  const cache=new Collection(Object.values(LANGUAGE_CHANNELS).map(x=>[x.role,{}]));
  members.set(id,{id,user:{bot:false},roles:{cache,add:async role=>{if(fail)throw Error("mock role failure");cache.set(role.id,role);changes.push(id)},remove:async role=>cache.delete(role.id)}});
 }
 const helpers=new Map();
 for(const key of ["english","spanish"])helpers.set(key,{id:"helper-"+key,members:new Collection(),mentionable:true});
 const guild={id:"test",members:{cache:members,fetch:async()=>members},roles:{fetch:async id=>id==="subscription"?{id,name:"Test",members}: [...helpers.values()].find(x=>x.id===id)}};
 client.channels.cache.set(CHANNELS.START_HERE,{guild});
 t.after(()=>client.channels.cache.delete(CHANNELS.START_HERE));
 t.mock.method(client.channels,"fetch",async id=>{
  if(![LANGUAGE_CHANNELS.english.channel,LANGUAGE_CHANNELS.spanish.channel].includes(id))return null;
  return {isTextBased:()=>true,permissionsFor:()=>({has:()=>true}),send:async payload=>sent.push({id,payload})};
 });
 t.mock.method(pool,"query",async sql=>{
  if(sql.includes("SELECT user_id, primary_language"))return {rows:[{user_id:"a",primary_language:"english"},{user_id:"b",primary_language:"spanish"}]};
  if(sql.includes("SELECT language_key, scoped_role_id"))return {rows:[...helpers].map(([language_key,r])=>({language_key,scoped_role_id:r.id}))};
  return {rows:[],rowCount:0};
 });
 t.mock.method(globalThis,"fetch",async()=>({ok:true,json:async()=>({data:{translations:[{translatedText:"Aviso"}]}})}));
 assert.equal(await sendLocalizedRoleNotification("subscription","Test notice","Test"),fail?0:2);
 assert.equal(sent.length,2);
 for(const {id,payload} of sent){
  const key=id===LANGUAGE_CHANNELS.english.channel?"english":"spanish";
  assert.deepEqual(payload.allowedMentions.roles,fail?[]:["helper-"+key]);
  assert.deepEqual(payload.allowedMentions.parse,[]);
 }
 if(!fail)assert.deepEqual(changes.sort(),["a","b"]);
});
