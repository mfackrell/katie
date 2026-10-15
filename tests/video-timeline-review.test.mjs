import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const load=(file,imports={})=>{const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>imports[name]??{}});return exports;};
test('actual independent assessment construction keeps measured timeline evidence through ordinary, saved-draft and clarification paths',()=>{
 const timing=load('lib/uploads/video-timing.ts');
 const evidence=load('lib/chat/video-evidence.ts',{'@/lib/uploads/video-timing':timing});
 const route=readFileSync('app/api/chat/route.ts','utf8');
 const start=route.indexOf('assessmentParams: {'),end=route.indexOf('\n                leadProvider:',start);
 const timelineContext='MEASURED VIDEO TIMELINE source_chat_id=source attachment_id=attachment fingerprint=sha256 measured_sample=29.9 status=partial gaps=unknown';
 for(const mode of ['ordinary','saved','clarification']){
  const value=vm.runInNewContext('({'+route.slice(start,end)+'})',{
   ...evidence,createParams:()=>({user:'Original actual task',persona:'Katie'}),result:{model:'offline'},
   hasVideoInput:false,attachments:[],isVideoAttachment:()=>false,
   savedDraftOriginalTask:mode==='saved'?'Saved original task':null,
   pendingReviewClarification:mode==='clarification'?{pending:{sourceTurns:['Build a timestamped timeline'],question:'Which interval?'}}:null,
   message:'Unknown',mediaMemory:null,timelineContext,
   reviewSourceParams:{user:'LEAKED candidate draft'},
  }).assessmentParams;
  assert.ok(value.user.includes(timelineContext));assert.ok(!value.user.includes('LEAKED'));
  assert.match(value.user,mode==='ordinary'?/Original actual task/:mode==='saved'?/Saved original task/:/Build a timestamped timeline/);
 }
});

test('actual chat route resolves fresh/saved/current video timeline turns before ordinary saved-evidence or media selection',()=>{
 const intent=load('lib/video-timeline/intent.ts');
 const route=readFileSync('app/api/chat/route.ts','utf8');
 const start=route.indexOf('    const temporalIntent ='),end=route.indexOf('    // A question about the video',start);
 const chooseStart=route.indexOf('    const attachmentDecision: AttachmentDecision ='),chooseEnd=route.indexOf('    const selectedBeforePruning',chooseStart);
 const choice=ts.transpileModule('async function choose(){'+route.slice(chooseStart,chooseEnd)+';return attachmentDecision;}; exports.choose=choose;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const file={id:'saved',chatId:'source',fileName:'same.mp4',mimeType:'video/mp4'};
 const other={...file,id:'new',fileName:'other.mp4'};
 const uploaded=[{role:'user',content:'build a timestamped timeline',attachments:[file]},
  {role:'assistant',content:'Timeline ready'}, {role:'user',content:'What is a checksum?'},
  {role:'assistant',content:'A checksum detects changes.'}];
 const cases=[
  {message:'build a timestamped timeline',newAttachments:[{...file,fileId:'fresh'}],catalog:[file],attachmentHistory:[],active:true},
  {message:'build a timestamped timeline of my saved video',newAttachments:[],catalog:[file],attachmentHistory:[],active:true},
  {message:'When did the error first appear?',newAttachments:[],catalog:[file],attachmentHistory:[{role:'user',attachments:[file]}],active:true},
  {message:'What happened in the last30seconds?',newAttachments:[],catalog:[file],attachmentHistory:[{role:'user',attachments:[file]}],active:true},
  {message:'build a timestamped timeline of same.mp4',newAttachments:[],catalog:[file,{...file,id:'duplicate'}],attachmentHistory:[],active:true,clarify:true},
  {message:'What happened in the last 30 seconds?',newAttachments:[],catalog:[file,other],attachmentHistory:uploaded,active:true,source:'saved'},
  {message:'What happened in the last 30 seconds?',newAttachments:[],catalog:[file,other],attachmentHistory:[...uploaded,{role:'user',content:'Inspect other.mp4'},{role:'user',content:'What is a checksum?'}],active:true,source:'new'},
  {message:'What happened in the last 30 seconds?',newAttachments:[],catalog:[file,other],attachmentHistory:[...uploaded,{role:'user',attachments:[other]},{role:'user',content:'What is a checksum?'}],active:true,source:'new'},
  {message:'What happened in the last 30 seconds?',newAttachments:[],catalog:[file,other],attachmentHistory:[...uploaded,{role:'user',attachments:[file,other]},{role:'user',content:'What is a checksum?'}],active:true,clarify:true},
  {message:'What happened in the last 30 seconds?',newAttachments:[],catalog:[file],attachmentHistory:[...uploaded,{role:'user',attachments:[{...other,mimeType:'text/plain'}]}],active:false},
  {message:'build a project timeline',newAttachments:[],catalog:[file],attachmentHistory:[],active:false},
  {message:'When did the error first appear?',newAttachments:[],catalog:[],attachmentHistory:[{role:'user',attachments:[{...file,mimeType:'text/plain'}]}],active:false},
 ];
 return Promise.all(cases.map(async fixture=>{
  const context={...intent,...fixture,chatId:"current",exports:{},console};vm.createContext(context);
  const resolved=vm.runInContext('(function(){'+route.slice(start,end)+';return {timelineActive,timelineSelection};})()',context);
  assert.equal(resolved.timelineActive,fixture.active,fixture.message);
  if(fixture.source)assert.equal(resolved.timelineSelection.source.id,fixture.source);
  if(fixture.clarify)assert.ok(resolved.timelineSelection.clarification);
  if(resolved.timelineActive){
   let selectionCalls=0;Object.assign(context,resolved,{mediaMemory:null,savedVideoFollowUp:null,selectStoredAttachments:()=>{selectionCalls++;throw Error('ordinary media routing');}});
   vm.runInContext(choice,context);const selected=await context.exports.choose();assert.equal(selected.selections.length,0);assert.equal(selectionCalls,0);
  }
 }));
});

test('actual intent and route reject unrelated chronology, upload age and comparisons despite an older video',()=>{
 const intent=load('lib/video-timeline/intent.ts');
 const route=readFileSync('app/api/chat/route.ts','utf8');
 const start=route.indexOf('    const temporalIntent ='),end=route.indexOf('    // A question about the video',start);
 const file={id:'known',chatId:'source',fileName:'known.mp4',mimeType:'video/mp4'};
 const resolve=message=>vm.runInNewContext('(function(){'+route.slice(start,end)+';return {timelineActive,timelineSelection,temporalIntent};})()',{
  ...intent,message,newAttachments:[],catalog:[file],attachmentHistory:[{role:'user',attachments:[file]}],
 });
 for(const message of ['Build a timeline of World War II','Find my video uploaded last 30 seconds','Compare between 20 and 45 dollars']){
  const result=resolve(message);assert.equal(result.timelineActive,false,message);assert.equal(result.timelineSelection.source,undefined);assert.equal(result.temporalIntent,null);
 }
 const missing=resolve('Build a timestamped timeline of missing.mp4');
 assert.equal(missing.timelineSelection.source,undefined);assert.match(missing.timelineSelection.clarification,/missing\.mp4/);
 assert.ok(resolve('What happened between 1 and 10 minutes?').temporalIntent.error);
 for(const text of ['between 1.5:20 and 2:30','between 1:2.5:03 and 2:03:04','between 00:60 and 02:00','between 1 seconds and 2 minutes'])assert.ok(intent.timelineIntent(text)?.error,text);
 for(const text of ['Build a timestamped timeline of my saved video','Build a timestamped timeline of known.mp4','Continue the timestamped timeline','When did the error first appear?','What happened in the last 30 seconds?','What happened between 00:20 and 00:45?'])assert.equal(resolve(text).timelineActive,true,text);
 const newer=[{role:'user',attachments:[file]},{role:'user',content:'Build a timestamped timeline of missing.mp4'}];
 assert.equal(intent.resolveTimelineSource('Continue the timestamped timeline',[],[file],newer).source,undefined);
});

test('actual route fingerprint preserves fresh and saved timeline source identity and ordinary payloads',async()=>{
 const {webcrypto}=await import('node:crypto');
 // Execute the production fingerprint helper with Node webcrypto in its realm.
 let receipt;
 const client={from:()=>({
  insert:async row=>{if(receipt)return {error:{message:'duplicate'}};receipt=row;return {error:null};},
  select:()=>({eq:()=>({maybeSingle:async()=>({data:receipt,error:null})})}),
 })};
 const exports={};vm.runInNewContext(ts.transpileModule(readFileSync('lib/chat/request-idempotency.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:()=>({getSupabaseAdminClient:()=>client}),TextEncoder,crypto:webcrypto});
 const route=readFileSync('app/api/chat/route.ts','utf8');
 const start=route.indexOf('    const requestFingerprint ='),end=route.indexOf('    const idempotencyClaim =',start);
 const fingerprint=async({fresh=[],saved,timelineActive=true}={})=>{
  const context={fingerprintChatRequest:exports.fingerprintChatRequest,actorId:'actor',chatId:'chat',message:'same',images:[],attachments:[],freshVideoReferences:fresh,timelineSelection:saved?{source:saved}:{},timelineActive,overrideProvider:null,overrideModel:null,activeRepoId:null,repoInjectionEnabled:false};
  return vm.runInNewContext('(async()=>{'+route.slice(start,end)+'return requestFingerprint;})()',context);
 };
 const a={id:'a',fileId:'a',chatId:'chat',fileName:'same.mp4',mimeType:'video/mp4'}, b={...a,id:'b',fileId:'b'};
 assert.notEqual(await fingerprint({fresh:[a]}),await fingerprint({fresh:[b]}));
 assert.equal(await fingerprint({fresh:[a]}),await fingerprint({fresh:[{...a,preview:'renewed'}]}));
 assert.notEqual(await fingerprint({saved:a}),await fingerprint({saved:b}));
 assert.notEqual(await fingerprint({saved:a}),await fingerprint({saved:{...a,chatId:'other-source'}}));
 assert.equal(await fingerprint({saved:a}),await fingerprint({saved:{...a,preview:'renewed'}}));
 const claim=async source=>exports.claimChatRequest({requestId:'same-request-id',actorId:'actor',chatId:'chat',requestFingerprint:await fingerprint({fresh:[source]})});
 assert.equal((await claim(a)).mode,'claimed');
 assert.equal((await claim({...a,preview:'renewed'})).mode,'existing');
 assert.equal((await claim(b)).mode,'conflict');
 assert.equal(await fingerprint({timelineActive:false}),await exports.fingerprintChatRequest({actorId:'actor',chatId:'chat',message:'same',images:[],fileReferences:[],overrideProvider:null,overrideModel:null,activeRepoId:null,repoInjectionEnabled:false}));
});

test('actual detailed-media dispatch never calls a provider for rejected requests or unresolved names',async()=>{
 const intent=load('lib/video-timeline/intent.ts');
 const route=readFileSync('app/api/chat/route.ts','utf8');
 const start=route.indexOf('    const temporalIntent ='),end=route.indexOf('    // A question about the video',start);
 const dispatchStart=route.indexOf('            if (timelineActive && temporalIntent) {');
 const dispatchEnd=route.indexOf('            if (!timelineActive && pendingReviewClarification)',dispatchStart);
 const file={id:'known',fileId:'known',chatId:'source',fileName:'known.mp4',mimeType:'video/mp4'};
 for(const fresh of [[],[{...file,id:'fresh',fileId:'fresh'}]]){
  for(const message of ['Build a timeline of World War II','Find my video uploaded last 30 seconds','Compare between 20 and 45 dollars','Build a timestamped timeline of missing.mp4']){
   let calls=0;
   const result=await vm.runInNewContext('(async()=>{'+route.slice(start,end)+route.slice(dispatchStart,dispatchEnd)+'return {timelineActive,timelineSelection,timelineContext};})()',{
    ...intent,message,chatId:'current',actorId:'actor',providers:[],newAttachments:fresh,catalog:[file],attachmentHistory:[{role:'user',attachments:[file]}],savedAttachments:[],
    persistedVideoSourceByFileId:new Map(fresh.map(f=>[f.fileId,f])),runVideoTimeline:()=>{calls++;throw Error('unrequested detailed-media call');},
   });
   assert.equal(calls,0,message);
   if(message.includes('missing.mp4')){assert.equal(result.timelineSelection.source,undefined);assert.match(result.timelineContext,/missing\.mp4/);}
  }
 }
});

test('literal source matching preserves full filenames and never matches a filename suffix',()=>{
 const {resolveTimelineSource}=load('lib/video-timeline/intent.ts');
 const file={id:'known',chatId:'source',fileName:'known.mp4',mimeType:'video/mp4'};
 const spaced={...file,id:'spaced',fileName:'my recording.mp4'};
 const history=[{role:'user',attachments:[file]}];
 assert.equal(resolveTimelineSource('Build a timestamped timeline of "my recording.mp4"',[],[file,spaced],history).source.id,'spaced');
 for(const message of ['Build a timestamped timeline of unknown.mp4','Build a timestamped timeline of known.mp4backup']){
  assert.equal(resolveTimelineSource(message,[],[file],history).source,undefined);
 }
 const missingWithUpload=[{role:'user',content:'Build a timestamped timeline of missing.mp4',attachments:[file]}];
 assert.equal(resolveTimelineSource('Continue the timestamped timeline',[],[file],missingWithUpload).source,undefined);
});
