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
 const cases=[
  {message:'build a timestamped timeline',newAttachments:[{...file,fileId:'fresh'}],catalog:[file],attachmentHistory:[],active:true},
  {message:'build a timestamped timeline of my saved video',newAttachments:[],catalog:[file],attachmentHistory:[],active:true},
  {message:'When did the error first appear?',newAttachments:[],catalog:[file],attachmentHistory:[{role:'user',attachments:[file]}],active:true},
  {message:'What happened in the last30seconds?',newAttachments:[],catalog:[file],attachmentHistory:[{role:'user',attachments:[file]}],active:true},
  {message:'build a timestamped timeline of same.mp4',newAttachments:[],catalog:[file,{...file,id:'duplicate'}],attachmentHistory:[],active:true,clarify:true},
  {message:'build a project timeline',newAttachments:[],catalog:[file],attachmentHistory:[],active:false},
  {message:'When did the error first appear?',newAttachments:[],catalog:[],attachmentHistory:[{role:'user',attachments:[{...file,mimeType:'text/plain'}]}],active:false},
 ];
 return Promise.all(cases.map(async fixture=>{
  const context={...intent,...fixture,exports:{},console};vm.createContext(context);
  const resolved=vm.runInContext('(function(){'+route.slice(start,end)+';return {timelineActive,timelineSelection};})()',context);
  assert.equal(resolved.timelineActive,fixture.active,fixture.message);
  if(fixture.clarify)assert.ok(resolved.timelineSelection.clarification);
  if(resolved.timelineActive){
   let selectionCalls=0;Object.assign(context,resolved,{mediaMemory:null,savedVideoFollowUp:null,selectStoredAttachments:()=>{selectionCalls++;throw Error('ordinary media routing');}});
   vm.runInContext(choice,context);const selected=await context.exports.choose();assert.equal(selected.selections.length,0);assert.equal(selectionCalls,0);
  }
 }));
});
