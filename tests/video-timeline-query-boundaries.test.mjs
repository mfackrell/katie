import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const load=path=>{const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:()=>({})});return exports;};
const {timelineIntent,resolveTimelineSource}=load('lib/video-timeline/intent.ts');
const {runVideoTimeline}=load('lib/video-timeline/service.ts');
const file={id:'video',chatId:'source',fileName:'same.mp4',mimeType:'video/mp4'};

test('resolver-accepted Unicode punctuation does not become filename event terms',()=>{
 let checked=0;
 for(let point=0;point<=0xffff;point++){
  const punctuation=String.fromCodePoint(point);
  if(!/\p{P}/u.test(punctuation))continue;
  const request=`When did the error first appear in same.mp4${punctuation}`;
  const selected=resolveTimelineSource(request,[],[file],[]).source;
  if(!selected)continue;
  const parsed=timelineIntent(request,selected.fileName);
  assert.equal(parsed.kind,'first');
  assert.doesNotMatch(parsed.query,/same|mp4/i,`U+${point.toString(16)}`);
  assert.match(parsed.query,/error/);checked++;
 }
 assert.ok(checked>100);
});

test('exact review counterexamples retrieve cached error evidence with no media work',async()=>{
 for(const request of [
  'When did the error first appear in same.mp4—please?',
  'When did the error first appear in same.mp4。',
  'When did the error first appear in "same.mp4"—please?',
  'When did the error first appear in same.mp4…',
 ]){
  const source=resolveTimelineSource(request,[],[file],[]).source;
  assert.equal(source?.id,file.id);
  const parsed=timelineIntent(request,source.fileName);assert.equal(parsed.query,'error');
  let searches=0;
  const observed={description:'error visible',frame_ids:['f'],observed_start:12,observed_end:12,model:'saved',window_status:'complete'};
  const windows=[{requested_start:0,requested_end:30,duration:60,status:'complete',events:[observed],frames:[{id:'f',seconds:12}],failure:null,model:'saved'}];
  const client={rpc:async(name,args)=>{
   if(name==='read_video_timeline')return {data:args.p_fingerprint?windows:[],error:null};
   assert.equal(name,'search_video_timeline_events');assert.equal(args.p_query,'error');searches++;
   return {data:[observed],error:null};
  }};
  const forbidden=()=>{assert.fail('Cached first-occurrence search must not decode or call a provider');};
  const result=await runVideoTimeline({actorId:'actor',chatId:'target',source,intent:parsed,providers:[]},{client:()=>client,source:async()=>({fingerprint:'a'.repeat(64),source:new Blob(['offline'])}),probe:forbidden,decode:forbidden});
  assert.match(result,/error visible/);assert.equal(searches,1);
 }
});

test('literal event wording, similar filenames and bounded queries retain their meaning',()=>{
 assert.equal(timelineIntent('When did "red—alert" first appear in same.mp4。','same.mp4').query,'"red—alert"');
 assert.equal(timelineIntent('When did the word "please" first appear in same.mp4。','same.mp4').query,'word "please"');
 assert.equal(timelineIntent('First observed please in same.mp4。','same.mp4').query,'please');
 assert.match(timelineIntent('When did the error first appear in unknownsame.mp4?','same.mp4').query,/unknownsame/);
 assert.match(timelineIntent('When did the error first appear in same.mp4backup?','same.mp4').query,/same mp4backup/);
 const bounded=timelineIntent('When did the error first appear between 00:20 and 00:45 in same.mp4—please?','same.mp4');
 assert.equal(bounded.query,'error');assert.equal(bounded.start,20);assert.equal(bounded.end,45);
 assert.equal(timelineIntent('What happened in the last 30 seconds?','same.mp4').kind,'tail');
 assert.equal(resolveTimelineSource('When did the error first appear in missing.mp4。',[],[file],[]).source,undefined);
 for(const suffix of ['_','_backup']){
  const selected=resolveTimelineSource(`When did the error first appear in same.mp4${suffix}?`,[],[file],[]);
  assert.equal(selected.source,undefined);assert.ok(selected.clarification);
 }
 assert.ok(resolveTimelineSource('When did the error first appear in same.mp4。',[],[file,{...file,id:'other'}],[]).clarification);
});
