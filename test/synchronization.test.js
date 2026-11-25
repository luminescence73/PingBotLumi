import test from "node:test";
import assert from "node:assert/strict";
import { client } from "../src/runtime/client.js";
import { pool } from "../src/runtime/database.js";
import { handleGeneralMessageUpdate, deleteTranslatedGroup, updateReactionSummaries } from "../src/translation/general.js";
import { maybeHighlightNative, removeHighlight } from "../src/community/highlights.js";
import { startTournamentVote, closeTournamentVote, finishTournament } from "../src/events/tournaments.js";
import { TOURNAMENTS } from "../roleConfig.js";

test("translated edit retains reply link, attachment and reactions; deletion removes copies",async t=>{
 const edits=[],deletes=[],queries=[];
 const row={message_id:"copy",channel_id:"test-copy-channel",language_key:"spanish",base_content:"Old"};
 const hook={editMessage:async(...x)=>edits.push(x),deleteMessage:async x=>deletes.push(x)};
 t.mock.method(client.channels,"fetch",async()=>({id:row.channel_id,isTextBased:()=>true,fetchWebhooks:async()=>[],createWebhook:async()=>hook}));
 t.mock.method(globalThis,"fetch",async()=>({ok:true,json:async()=>({data:{translations:[{translatedText:"Hola"}]}})}));
 t.mock.method(pool,"query",async(sql,args)=>{
  queries.push({sql,args});
  if(sql.includes("JOIN translation_groups"))return {rows:[{is_source:true,source_language:"english",group_id:"group",reply_to_group_id:"parent"}]};
  if(sql.includes("language_key ="))return {rows:[args[0]==="parent"?{channel_id:"parent-channel",message_id:"parent-copy"}:row]};
  if(sql.includes("COUNT(DISTINCT"))return {rows:[{emoji_key:"👍",count:2}]};
  if(sql.includes("is_source = FALSE"))return {rows:[row]};
  return {rows:[],rowCount:1};
 });
 await handleGeneralMessageUpdate({id:"source",guild:{id:"guild"},content:"Edited probe",attachments:new Map([["a",{url:"https://example.com/image.png"}]])});
 assert.equal(edits.length,1);
 for(const part of ["Hola","parent-copy","https://example.com/image.png","👍 2"])assert.ok(edits[0][1].content.includes(part));
 await updateReactionSummaries("group");
 assert.equal(edits.length,2);
 assert.deepEqual(edits[1][1].allowedMentions,{parse:[]});
 await deleteTranslatedGroup("group");
 assert.deepEqual(deletes,["copy"]);
 assert.ok(queries.some(x=>x.sql.startsWith("DELETE FROM translation_groups")));
});
test("highlights respect threshold, update existing post and remove deleted source",async t=>{
 let stored=false;const sent=[],edited=[],deleted=[];
 const highlight={id:"highlight",edit:async x=>edited.push(x),delete:async()=>deleted.push(true)};
 t.mock.method(client.channels,"fetch",async()=>({isTextBased:()=>true,send:async x=>{sent.push(x);return highlight},messages:{fetch:async()=>highlight}}));
 t.mock.method(pool,"query",async sql=>{
  if(sql.startsWith("SELECT"))return {rows:stored?[{highlight_message_id:"highlight"}]:[]};
  if(sql.includes("INSERT INTO highlights"))stored=true;
  if(sql.startsWith("DELETE"))stored=false;
  return {rows:[]};
 });
 const msg={id:"source",channel:{id:"social"},author:{username:"Tester",displayAvatarURL:()=>"https://example.com/avatar.png"},content:"Test highlight",url:"https://discord.com/channels/1/2/3",createdAt:new Date(),attachments:new Map(),reactions:{cache:new Map([["a",{emoji:{name:"👍"},count:3}]])}};
 await maybeHighlightNative(msg);assert.equal(sent.length,0);
 msg.reactions.cache.get("a").count=4;
 await maybeHighlightNative(msg);assert.equal(sent.length,1);
 await maybeHighlightNative(msg);assert.equal(edited.length,1);
 await removeHighlight(msg.id);assert.equal(deleted.length,1);assert.equal(stored,false);
});
test("stale tournament transitions cannot send duplicate alerts; final round closes correctly",async t=>{
 const queries=[];
 t.mock.method(pool,"query",async(sql,args)=>{queries.push({sql,args});return {rows:[],rowCount:0}});
 const state={tournament:"sever",active_date:"2026-11-21",round:3,phase:"battle"};
 assert.equal(await startTournamentVote(state,"staff"),false);
 assert.equal(queries.length,1);
 assert.equal(queries[0].args[5],4);
 assert.equal(queries[0].args[6],"voting");
 await closeTournamentVote({...state,round:TOURNAMENTS.sever.rounds,phase:"voting"});
 assert.equal(queries[1].args[6],"final_battle");
 assert.equal(await finishTournament(state),false);
 assert.equal(queries[2].args[6],"complete");
});
