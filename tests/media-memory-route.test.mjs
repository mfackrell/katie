import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as zod from 'zod';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
function load(file,imports={}) {
 const exports={};
 vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>imports[name]??{},Date,Set,Map,console});
 return exports;
}
test('actual chat construction isolates locator/recall from selector and restoration on matches, no match and query failure',async()=>{
 const route=readFileSync('app/api/chat/route.ts','utf8');
 const start=route.indexOf('    const memoryMode =');
 const end=route.indexOf('    const selectedBeforePruning =',start);
 assert.ok(start>0 && end>start);
 const selection=load('lib/chat/attachment-selection.ts',{zod});
 for(const outcome of ['match','no-match','error']) for(const message of ['find the recording from last week showing checkout','recall my saved video about checkout']) {
  let selectors=0,restores=0;
  const memory=load('lib/media-memory/evidence.ts',{'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>({rpc:async()=>({data:outcome==='match'?[{source_chat_id:'older-source',attachment_id:'attachment',filename:'same.mp4',kind:'analysis',version:'request:Qwen/full-original-version',start_offset:24000,body:'Distinctive checkout neon marker',coverage:'sampled',original_available:false}]:[],error:outcome==='error'?{message:'missing table'}:null})})}});
  const result=await vm.runInNewContext(ts.transpileModule(`(async()=>{${route.slice(start,end)} return {attachmentDecision,mediaMemory};})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
   ...memory,getChatById:async()=>({actorId:'actor'}),savedOriginalExists:async()=>false,message,actorId:'actor',chatId:'current',newAttachments:[],attachmentHistory:[],catalog:[],
   loadSavedVideoFollowUp:async()=>{throw Error('historical request cannot select recent unrelated video');},
   selectStoredAttachments:async()=>{selectors++;throw Error('must not invoke advisory selector');},
  });
  const sources=await selection.loadSelectedAttachmentSources(result.attachmentDecision,async()=>{restores++;throw Error('must not renew or inspect media');});
  assert.equal(selectors,0); assert.equal(restores,0); assert.equal(sources.references.length,0);
  if(outcome==='match') assert.match(result.mediaMemory.context,/older-source.*24000/);
  if(outcome==='error') assert.equal(result.mediaMemory.status,'search-unavailable');
 }
});
