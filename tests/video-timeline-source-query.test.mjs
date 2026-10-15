import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as zod from 'zod';
const load=(file,imports={})=>{const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>imports[name]??{}});return exports;};
const intent=load('lib/video-timeline/intent.ts');
const observations=load('lib/video-timeline/observations.ts',{zod});
const service=load('lib/video-timeline/service.ts',{'./observations':observations});
const route=readFileSync('app/api/chat/route.ts','utf8');
const selection=route.slice(route.indexOf('    const temporalIntent ='),route.indexOf('    // A question about the video'));
const dispatch=route.slice(route.indexOf('            if (timelineActive && temporalIntent) {'),route.indexOf('            personaForGeneration += `\\n\\n${selectionContext()}`;'));

test('actual chat dispatch searches source-neutral events for fresh/saved and cached review paths without media calls',async()=>{
 for(const [filename,request,query,start,end] of [
  ['same.mp4','When did the error first appear in same.mp4?','error',0,60],
  ['My [capture]+(1).mp4','When did the error first appear in "MY [CAPTURE]+(1).MP4"?','error',0,60],
  ['error.mp4',"When did the error first appear in 'error.mp4'?",'error',0,60],
  ['same.mp4','When did the error first appear between 00:20 and 00:45 in same.mp4?','error',20,45],
  ['same.mp4','When did the error first appear?','error',0,60],
  ['x'.repeat(210)+'.mp4','When did the error first appear in '+ 'x'.repeat(210)+'.mp4?','error',0,60],
  ['same.mp4','When did "red alert" first appear in same.mp4?','"red alert"',0,60],
 ]) for(const mode of ['fresh','saved','draft','clarification']) {
  const file={id:'video',fileId:'video',chatId:'source',fileName:filename,mimeType:'video/mp4'};
  const calls=[];let mediaCalls=0;
  const forbidden=()=>{mediaCalls++;throw Error('media call forbidden');};
  const runVideoTimeline=async input=>{
   assert.equal(input.cachedOnly??false,mode==='draft'||mode==='clarification');
   return service.runVideoTimeline(input,{
    client:()=>({rpc:async(name,args)=>{
     calls.push({name,args});
     if(name==='read_video_timeline')return {data:[{duration:60,requested_start:0,requested_end:60,status:'complete',frames:[{id:'f',seconds:25}],events:[]} ]};
     assert.equal(name,'search_video_timeline_events');
     const matches=args.p_query.toLowerCase().split(/\s+/).every(term=>'error visible "red alert"'.includes(term));
     return {data:matches?[{description:'error visible',observed_start:25,observed_end:25,frame_ids:['f']}]:[]};
    }}),source:async()=>({fingerprint:'offline',source:null}),probe:forbidden,decode:forbidden,
   });
  };
  const review=mode==='draft'||mode==='clarification';
  const result=await vm.runInNewContext(ts.transpileModule('(async()=>{'+selection+dispatch+'return timelineContext;})()', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
   ...intent,message:review?'Unknown':request,chatId:'current',actorId:'actor',providers:[{name:'grok',listModels:forbidden,generate:forbidden}],
   newAttachments:mode==='fresh'?[file]:[],catalog:[file],attachmentHistory:[{role:'user',attachments:[file]}],savedAttachments:[],
   persistedVideoSourceByFileId:new Map([['video',file]]),runVideoTimeline,
   pendingReviewClarification:review?{pending:{}}:null,savedDraftOriginalTask:mode==='draft'?request:null,savedDraftReviewTask:()=>request,
  });
  const search=calls.filter(c=>c.name==='search_video_timeline_events');
  assert.equal(search.length,1,mode+request);assert.equal(search[0].args.p_query,query);
  assert.equal(search[0].args.p_start,start);assert.equal(search[0].args.p_end,end);
  assert.equal(search[0].args.p_actor,'actor');assert.equal(search[0].args.p_source_chat,'source');
  assert.match(result,/"description":"error visible"/);assert.equal(mediaCalls,0);
 }
});

test('resolved filename affects only query and respects literal boundaries and the query cap',()=>{
 for(const request of ['Build a timestamped timeline of same.mp4','What happened between 00:20 and 00:45 in same.mp4?','What happened in the last 30 seconds?','Build a project timeline','Find my video uploaded last 30 seconds'])
  assert.deepEqual(intent.timelineIntent(request,'same.mp4'),intent.timelineIntent(request));
 for(const request of ['When did the error first appear in unknownsame.mp4?','When did the error first appear in same.mp4backup?'])
  assert.deepEqual(intent.timelineIntent(request,'same.mp4'),intent.timelineIntent(request));
 const request='When did the error first appear between 00:20 and 00:45 in same.mp4 page 2?';
 const before=intent.timelineIntent(request),after=intent.timelineIntent(request,'same.mp4');
 assert.equal(JSON.stringify({...after,query:before.query}),JSON.stringify(before));
 assert.equal(intent.timelineIntent('When did '+ 'x'.repeat(250)+' first appear in same.mp4?','same.mp4').query.length,200);
});

test('first queries clarify missing, wrong and duplicate sources before dispatch',async()=>{
 const file={id:'video',fileId:'video',chatId:'source',fileName:'same.mp4',mimeType:'video/mp4'};
 for(const [message,catalog,fresh] of [
  ['When did the error first appear in missing.mp4?',[file],[]],
  ['When did the error first appear in unknownsame.mp4?',[file],[]],
  ['When did the error first appear in same.mp4?',[file,{...file,id:'duplicate'}],[]],
  ['When did the error first appear in missing.mp4?',[file],[file]],
 ]) {
  let calls=0;
  const result=await vm.runInNewContext(ts.transpileModule('(async()=>{'+selection+dispatch+'return {timelineSelection,timelineContext};})()', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
   ...intent,message,chatId:'current',actorId:'actor',providers:[],newAttachments:fresh,catalog,
   attachmentHistory:[{role:'user',attachments:[file]}],savedAttachments:[],persistedVideoSourceByFileId:new Map([['video',file]]),
   runVideoTimeline:()=>{calls++;throw Error('unresolved source');},pendingReviewClarification:null,
  });
  assert.equal(result.timelineSelection.source,undefined);assert.match(result.timelineContext,/Which recording/);assert.equal(calls,0);
 }
});
