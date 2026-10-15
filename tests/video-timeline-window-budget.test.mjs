import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';

function harness(ranges, duration=300) {
 const windows=ranges.map(([start,end,status='complete'])=>({requested_start:start,requested_end:end,status,duration,events:[],frames:[],failure:null,model:'grok-4-test',lease_until:'2099-01-01T00:00:00Z'}));
 const calls={claims:[],decoded:[],generated:0,search:[]};
 const client={rpc:async(name,args)=>{
  if(name==='read_video_timeline')return {data:args.p_fingerprint ? windows.filter(w=>w.requested_end>=args.p_start && w.requested_start<=args.p_end) : [],error:null};
  if(name==='claim_video_timeline'){calls.claims.push(args);return {data:true,error:null};}
  if(name==='finish_video_timeline'){
   assert.equal(args.p_failure,null);
   const claim=calls.claims.at(-1);
   assert.equal(args.p_receipt,claim.p_receipt);
   windows.push({requested_start:claim.p_start,requested_end:claim.p_end,status:'complete',duration,events:args.p_events,frames:args.p_frames,failure:null,model:args.p_model,lease_until:'2099-01-01T00:00:00Z'});
   return {data:true,error:null};
  }
  if(name==='search_video_timeline_events'){calls.search.push(args);return {data:[],error:null};}
  assert.fail(`Unexpected RPC ${name}`);
 }};
 const evidence={TIMELINE_VERSION:'test-v1',TIMELINE_CAVEAT:'Sampled evidence; gaps remain unknown.',
  bindTimelineFrames:frames=>frames.map((f,i)=>({id:`frame-${i}`,seconds:f.timestampSeconds,sha256:'b'.repeat(64)})),
  validateObservations:(_text,frames)=>({events:[{description:'An offline test observation',frame_ids:[frames[0].id],observed_start:frames[0].seconds,observed_end:frames[0].seconds}],partial:false}),
 };
 const exports={};
 const compiled=ts.transpileModule(readFileSync('lib/video-timeline/service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(compiled,{exports,console,require:name=>name==='node:crypto'?crypto:name==='./observations'?evidence:{}});
 const deps={client:()=>client,source:async()=>({fingerprint:'a'.repeat(64),source:new Blob(['offline fixture'])}),probe:async()=>duration,
  decode:async(_blob,{window})=>{calls.decoded.push(window);return Array.from({length:10},(_,i)=>({timestampSeconds:window.start+(window.end-window.start)*i/9,dataUrl:'data:image/jpeg;base64,b2ZmbGluZQ=='}));},
 };
 const providers=[{name:'grok',listModels:async()=>['grok-4-test'],generate:async()=>{calls.generated++;return {text:'{"observations":[]}',model:'grok-4-test'};}}];
 return {calls,run:(intent,cachedOnly=false)=>exports.runVideoTimeline({actorId:'actor',chatId:'target',source:{id:'attachment',chatId:'source',fileName:'recording.mp4'},intent,providers,cachedOnly},deps)};
}

const cases=[
 ['skip a cached prefix',[[0,30]],{kind:'range',start:20,end:45},[30,45]],
 ['stop before a cached suffix',[[30,45]],{kind:'range',start:20,end:45},[20,30]],
 ['analyze only the first gap between receipts',[[0,25],[35,45]],{kind:'range',start:20,end:45},[25,35]],
 ['reuse adjacent complete windows',[[0,30],[30,60]],{kind:'range',start:20,end:45},null],
 ['clamp mixed-history build continuation to 120 seconds',[[0,30],[30,60],[60,90],[90,110]],{kind:'build',resume:true},[110,120]],
 ['do not extend a completed whole-pass prefix',[[0,30],[30,60],[60,90],[90,120]],{kind:'build',resume:true},null],
 ['preserve explicit later numeric inspection',[[0,30]],{kind:'range',start:130,end:150},[130,150]],
 ['retain the original 30-second requested-piece budget',[[0,30]],{kind:'range',start:20,end:90},[30,50]],
 ['do not advance a build past a processing receipt',[[0,20],[20,30,'processing']],{kind:'build',resume:true},null],
 ['keep first-occurrence queries read-only',[[0,30]],{kind:'first',query:'error',start:20,end:45},null],
];
for(const [name,ranges,intent,expected] of cases)test(name,async()=>{
 const h=harness(ranges);
 const answer=await h.run(intent);
 assert.match(answer,/MEASURED VIDEO TIMELINE/);
 assert.equal(h.calls.generated,expected?1:0);
 assert.equal(h.calls.claims.length,expected?1:0);
 assert.equal(h.calls.decoded.length,expected?1:0);
 if(expected){
  assert.deepEqual([h.calls.claims[0].p_start,h.calls.claims[0].p_end],expected);
  assert.deepEqual([h.calls.decoded[0].start,h.calls.decoded[0].end],expected);
  assert.ok(expected[1]-expected[0]<=30);
  if(intent.kind==='build')assert.ok(expected[1]<=120);
 }
 assert.equal(h.calls.search.at(-1).p_query,intent.query ?? '');
 if(intent.kind==='range'||intent.kind==='first'){
  assert.equal(h.calls.search.at(-1).p_start,intent.start);
  assert.equal(h.calls.search.at(-1).p_end,intent.end);
 }
});
test('cached-only review never fills an uncovered interval',async()=>{
 const h=harness([[0,30]]);
 const answer=await h.run({kind:'range',start:20,end:45},true);
 assert.match(answer,/MEASURED VIDEO TIMELINE/);
 assert.equal(h.calls.claims.length,0);assert.equal(h.calls.decoded.length,0);assert.equal(h.calls.generated,0);
});
