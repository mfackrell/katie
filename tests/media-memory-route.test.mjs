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
 for(const outcome of ['match','no-match','error']) for(const message of ['find the recording from last week showing checkout','recall my saved video about checkout','recall the previous video about checkout','recall the video uploaded from 2026-10-01 to 2026-10-02 about checkout']) {
  let selectors=0,restores=0;
  const memory=load('lib/media-memory/evidence.ts',{'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>({rpc:async()=>({data:outcome==='match'?[{source_chat_id:'older-source',attachment_id:'attachment',filename:'same.mp4',kind:'analysis',version:'request:Qwen/full-original-version',start_offset:24000,body:'Distinctive checkout neon marker',coverage:'sampled',original_available:false}]:[],error:outcome==='error'?{message:'missing table'}:null})})}});
  const result=await vm.runInNewContext(ts.transpileModule(`(async()=>{${route.slice(start,end)} return {attachmentDecision,mediaMemory};})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
   benchmarkRelay:false,selectFreshPdfSources:load('lib/chat/pdf-source-selection.ts',{'@/lib/uploads/pdf-inventory':load('lib/uploads/pdf-inventory.ts')}).selectFreshPdfSources,selectPdfEvidenceSource:load('lib/chat/pdf-source-selection.ts',{'@/lib/uploads/pdf-inventory':load('lib/uploads/pdf-inventory.ts'),'@/lib/media-memory/evidence':load('lib/media-memory/evidence.ts',{'@/lib/data/supabase/admin':{}})}).selectPdfEvidenceSource,pdfSourceTask:message,pdfTaskContext:null,pdfProgress:{projectContext:null},...memory,timelineActive:false,timelineSelection:{},getChatById:async()=>({actorId:'actor'}),savedOriginalExists:async()=>false,message,actorId:'actor',chatId:'current',newAttachments:[],attachmentHistory:[],catalog:[],
   loadSavedVideoFollowUp:async()=>{throw Error('historical request cannot select recent unrelated video');},
   selectStoredAttachments:async()=>{selectors++;throw Error('must not invoke advisory selector');},
  });
  const sources=await selection.loadSelectedAttachmentSources(result.attachmentDecision,async()=>{restores++;throw Error('must not renew or inspect media');});
  assert.equal(selectors,0); assert.equal(restores,0); assert.equal(sources.references.length,0);
  if(outcome==='match') assert.match(result.mediaMemory.context,/older-source.*24000/);
  if(outcome==='error') assert.equal(result.mediaMemory.status,'search-unavailable');
 }
});

test('ordinary anchored video questions use saved reports before memory search or source restoration', async () => {
 const route = readFileSync('app/api/chat/route.ts', 'utf8');
 const start = route.indexOf('    const memoryMode =');
 const end = route.indexOf('    const selectedBeforePruning =', start);
 assert.ok(start > 0 && end > start);
 const memory = load('lib/media-memory/evidence.ts');
 const video = load('lib/chat/saved-video-observations.ts');
 const selection = load('lib/chat/attachment-selection.ts', {zod});
 const history = [{role:'user', chatId:'current', createdAt:'2026-10-14T12:00:00Z', content:'Watch this video',
  attachments:[{id:'clip',chatId:'current',fileName:'checkout.mp4',mimeType:'video/mp4'}]}];
 for (const message of [
  'What happened after checkout in the video?',
  'What happened before checkout in the video?',
  'What can you tell from the video?',
  'Does the video show the previous page after checkout?',
 ]) {
  let reads = 0, selectors = 0, searches = 0, restores = 0;
  const result = await vm.runInNewContext(ts.transpileModule(`(async()=>{${route.slice(start,end)} return {attachmentDecision,savedVideoFollowUp};})()`,
   {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, {
   benchmarkRelay:false,selectFreshPdfSources:load('lib/chat/pdf-source-selection.ts',{'@/lib/uploads/pdf-inventory':load('lib/uploads/pdf-inventory.ts')}).selectFreshPdfSources,selectPdfEvidenceSource:load('lib/chat/pdf-source-selection.ts',{'@/lib/uploads/pdf-inventory':load('lib/uploads/pdf-inventory.ts'),'@/lib/media-memory/evidence':load('lib/media-memory/evidence.ts',{'@/lib/data/supabase/admin':{}})}).selectPdfEvidenceSource,pdfSourceTask:message,pdfTaskContext:null,pdfProgress:{projectContext:null},...memory,timelineActive:false,timelineSelection:{}, message, actorId:'actor',chatId:'current',newAttachments:[],attachmentHistory:history,catalog:[],
   loadSavedVideoFollowUp:params=>video.loadSavedVideoFollowUp(params,async scoped=>{
    reads++; assert.equal(scoped.actorId,'actor'); assert.equal(scoped.chatId,'current');
    assert.equal(scoped.attachmentPaths[0],'chats/current/clip.source');
    return [{chat_request_id:'request',attachment_path:'chats/current/clip.source',submitted_at:'2026-10-14T12:00:01Z',analysis_text:'Checkout opens the receipt page.',video_index:0}];
   }),
   retrieveSavedEvidence:async()=>{searches++;throw Error('unexpected memory search');},
   selectStoredAttachments:async()=>{selectors++;throw Error('unexpected selector');},
  });
  const sources = await selection.loadSelectedAttachmentSources(result.attachmentDecision,async()=>{restores++;throw Error('unexpected source restoration');});
  assert.equal(reads,1,message); assert.equal(searches,0,message); assert.equal(selectors,0,message); assert.equal(restores,0,message);
  assert.equal(sources.references.length,0); assert.match(result.savedVideoFollowUp.context,/Checkout opens the receipt page/);
 }
});


test('unsupported and mixed upload dates stop actual routing before SQL, recent evidence, selector, or media restoration',async()=>{
 const route=readFileSync('app/api/chat/route.ts','utf8');
 const start=route.indexOf('    const memoryMode =');
 const end=route.indexOf('    const selectedBeforePruning =',start);
 const memory=load('lib/media-memory/evidence.ts',{'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>{throw Error('date must not broaden into a query');}}});
 for(const message of [
  'find my recording from two weeks ago showing checkout',
  'recall the video from three months ago about checkout',
  'find my saved file from the past 20 days',
  'find my saved file from last week and before 2026-01-01',
  'find my video from yesterday or last week',
  'find my file from 2026-10-01 to 2026-10-02 and two months ago',
 ]) {
  const result=await vm.runInNewContext(ts.transpileModule(`(async()=>{${route.slice(start,end)} return {attachmentDecision,mediaMemory};})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
   benchmarkRelay:false,selectFreshPdfSources:load('lib/chat/pdf-source-selection.ts',{'@/lib/uploads/pdf-inventory':load('lib/uploads/pdf-inventory.ts')}).selectFreshPdfSources,selectPdfEvidenceSource:load('lib/chat/pdf-source-selection.ts',{'@/lib/uploads/pdf-inventory':load('lib/uploads/pdf-inventory.ts'),'@/lib/media-memory/evidence':load('lib/media-memory/evidence.ts',{'@/lib/data/supabase/admin':{}})}).selectPdfEvidenceSource,pdfSourceTask:message,pdfTaskContext:null,pdfProgress:{projectContext:null},...memory,timelineActive:false,timelineSelection:{},message,actorId:'actor',chatId:'chat',newAttachments:[],attachmentHistory:[],catalog:[],
   loadSavedVideoFollowUp:async()=>{throw Error('must not substitute recent recording');},
   selectStoredAttachments:async()=>{throw Error('must not restore media for clarification');},
  });
  assert.match(result.attachmentDecision.clarification,/upload date range/);
  assert.equal(result.attachmentDecision.selections.length,0);
  assert.equal(result.mediaMemory.hits.length,0);
 }
});
