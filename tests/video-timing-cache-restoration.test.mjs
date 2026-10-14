import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const nativeRequire=createRequire(import.meta.url);
const actor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const chat='11111111-1111-4111-8111-111111111111';
const id='22222222-2222-4222-8222-222222222222';
const timing={version:1,durationSeconds:2,sampleSeconds:[0,1]};
function fixture() {
  return {actorId:actor,hasSource:false,refreshedAt:Date.now(),decoderTiming:timing,
    reference:{fileName:'clip.mp4',mimeType:'video/mp4',attachmentKind:'video',videoFrames:[
      {timestampSeconds:0,dataUrl:'data:image/jpeg;base64,red'},
      {timestampSeconds:1,dataUrl:'data:image/jpeg;base64,blue'}]}};
}
function harness(record) {
  const modules=new Map();
  function load(path) {
    if(modules.has(path))return modules.get(path);
    const exports={};modules.set(path,exports);
    const require=name=>{
      if(name==='./video-timing')return load('lib/uploads/video-timing.ts');
      if(name==='./video-fallback-frames')return load('lib/uploads/video-fallback-frames.ts');
      if(name==='./server-video-frame-recovery')return {extractFramesFromPrivateVideo:async()=>{throw Error('unexpected decode');}};
      if(name==='./build-file-references')return {buildFileReferences:async()=>{throw Error('unexpected provider');},validateUploadFiles:()=>{}};
      if(name==='./video-handoffs')return {recordCompletedHandoffUpload:async()=>{throw Error('unexpected handoff');}};
      return nativeRequire(name);
    };
    vm.runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
      {exports,require,Buffer,Blob,File,Date,console,process,AbortSignal,WeakMap,Object,Array,Number});
    return exports;
  }
  const reads=[];
  const objects={download:async path=>{
    reads.push(path);
    return path===`chats/${chat}/${id}.json`?{data:new Blob([JSON.stringify(record)])}:{data:null,error:{message:'not found'}};
  }};
  const {createStoredUploadService}=load('lib/uploads/stored-uploads.ts');
  return {service:createStoredUploadService({from:()=>objects},'test-only-secret'),registry:load('lib/uploads/video-timing.ts'),reads};
}
const attachment={id,chatId:chat,actorId:actor,fileName:'clip.mp4',mimeType:'video/mp4',createdAt:'2026-10-14T00:00:00Z',hasOriginal:false};
test('actual saved-frame cache return and restore bind every exact returned frame after JSON hydration',async()=>{
  const h=harness(fixture());
  for(const ref of [await h.service.recoverSavedVideoFrames(chat,attachment,actor),await h.service.restore(chat,attachment,actor)]) {
    assert.equal(h.registry.getVideoTiming(ref)?.durationSeconds,2);
    assert.ok(ref.videoFrames.every(frame=>h.registry.hasMeasuredFrameTime(frame)));
  }
  assert.ok(h.reads.every(path=>path.endsWith('.json')));
});
test('missing-original early return retains only matching server timing on the actual cached frames',async()=>{
  const record=fixture();record.hasSource=true;
  const h=harness(record),ref=await h.service.recoverSavedVideoFrames(chat,attachment,actor);
  assert.equal(h.registry.getVideoTiming(ref)?.durationSeconds,2);
  assert.ok(ref.videoFrames.every(frame=>h.registry.hasMeasuredFrameTime(frame)));
  assert.equal(h.reads.filter(path=>path.endsWith('.source')).length,1);
});
test('mismatched cache metadata cannot bind frames or appear in delayed timing reads',async()=>{
  const record=fixture();record.decoderTiming={...timing,sampleSeconds:[0.3,1]};
  const h=harness(record),ref=await h.service.recoverSavedVideoFrames(chat,attachment,actor);
  assert.equal(h.registry.getVideoTiming(ref),undefined);
  assert.ok(ref.videoFrames.every(frame=>!h.registry.hasMeasuredFrameTime(frame)));
  assert.equal(await h.service.readVideoTiming(chat,id,actor),undefined);
});
test('wrong actor cannot recover cached frames or read their measured timing',async()=>{
  const h=harness(fixture()),other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await assert.rejects(h.service.recoverSavedVideoFrames(chat,{...attachment,actorId:other},other),/another actor/);
  assert.equal(await h.service.readVideoTiming(chat,id,other),undefined);
});
