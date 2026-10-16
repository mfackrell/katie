import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';

function load(path) {
 const exports={};
 const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{exports,require:name=>name==='node:crypto'?crypto:{},console});
 return exports;
}

test('unsupported first-occurrence tail restrictions clarify without database, decoder or inference work',async()=>{
 const {timelineIntent}=load('lib/video-timeline/intent.ts');
 const {runVideoTimeline}=load('lib/video-timeline/service.ts');
 const forbidden=()=>{assert.fail('An unsupported interval must not reach a media or storage dependency');};
 for(const message of [
  'When did the error first appear in the last 30 seconds?',
  'When did the error first appear in the last30seconds in the video?',
  'When did the error first appear in the last 2 minutes?',
  'When did the error first appear between 00:20 and 00:45 in the last 30 seconds?',
 ]) {
  const intent=timelineIntent(message);
  assert.equal(intent.kind,'first');assert.match(intent.error,/explicit start and end time/);
  const result=await runVideoTimeline({actorId:'actor',chatId:'chat',source:{id:'video',chatId:'source'},intent,providers:[]},
   {client:forbidden,source:forbidden,probe:forbidden,decode:forbidden});
  assert.equal(result,intent.error);
 }
});

test('supported tail and bounded first-occurrence queries preserve existing meaning',()=>{
 const {timelineIntent}=load('lib/video-timeline/intent.ts');
 assert.equal(JSON.stringify(timelineIntent('What happened in the last 30 seconds?')),JSON.stringify({kind:'tail',tail:30}));
 assert.equal(JSON.stringify(timelineIntent('When did the error first appear between 00:20 and 00:45?')),JSON.stringify({kind:'first',query:'error',start:20,end:45}));
 assert.equal(JSON.stringify(timelineIntent('When did the error first appear?')),JSON.stringify({kind:'first',query:'error'}));
});
