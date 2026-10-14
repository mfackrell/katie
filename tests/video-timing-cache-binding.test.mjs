import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function registry() {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('lib/uploads/video-timing.ts','utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, { exports, WeakMap, Object, Array, Number });
  return exports;
}
const timing = { version: 1, durationSeconds: 2, sampleSeconds: [0,1] };
const reference = () => ({ mimeType:'video/mp4', videoFrames:[
  { timestampSeconds:0, dataUrl:'data:image/jpeg;base64,red' },
  { timestampSeconds:1, dataUrl:'data:image/jpeg;base64,blue' }
] });
test('JSON-restored frames are untrusted until registered, then every returned frame is measured', () => {
  const r=registry(), source=reference(); r.registerVideoTiming(source,timing);
  const restored=JSON.parse(JSON.stringify(source));
  assert.equal(r.getVideoTiming(restored),undefined);
  assert.ok(restored.videoFrames.every(f=>!r.hasMeasuredFrameTime(f)));
  r.registerVideoTiming(restored,timing);
  assert.equal(r.getVideoTiming(restored).durationSeconds,2);
  assert.ok(restored.videoFrames.every(f=>r.hasMeasuredFrameTime(f)));
  assert.ok(source.videoFrames.every(f=>r.hasMeasuredFrameTime(f)));
});
test('a different cloned frame bundle never inherits an existing reference binding', () => {
  const r=registry(), ref=reference(); r.registerVideoTiming(ref,timing);
  const old=ref.videoFrames;
  ref.videoFrames=JSON.parse(JSON.stringify(old));
  assert.equal(r.getVideoTiming(ref),undefined);
  assert.ok(ref.videoFrames.every(f=>!r.hasMeasuredFrameTime(f)));
  assert.ok(old.every(f=>!r.hasMeasuredFrameTime(f)));
});
test('changed image bytes or PTS invalidate the full bundle', () => {
  for(const field of ['dataUrl','timestampSeconds']) {
    const r=registry(), ref=reference();r.registerVideoTiming(ref,timing);
    ref.videoFrames[0][field]=field==='dataUrl'?'data:image/jpeg;base64,other':0.3;
    assert.equal(r.getVideoTiming(ref),undefined);
    assert.ok(ref.videoFrames.every(f=>!r.hasMeasuredFrameTime(f)));
  }
});
test('invalid rehydration clears old trust and never trusts mismatched timestamp metadata', () => {
  for(const bad of [null,{}, {...timing,sampleSeconds:[0.3,1]}, {...timing,sampleSeconds:[0]}]) {
    const r=registry(),ref=reference();r.registerVideoTiming(ref,timing);
    r.registerVideoTiming(ref,bad);
    assert.equal(r.getVideoTiming(ref),undefined);
    assert.ok(ref.videoFrames.every(f=>!r.hasMeasuredFrameTime(f)));
  }
});
test('frame-array decoder registration and restored reference registration both bind actual frames', () => {
  const r=registry(), decoded=reference().videoFrames;r.registerVideoTiming(decoded,timing);
  assert.ok(decoded.every(f=>r.hasMeasuredFrameTime(f)));
  const validated=decoded.map(f=>({...f}));
  assert.ok(validated.every(f=>!r.hasMeasuredFrameTime(f)));
  r.registerVideoTiming(validated,r.getVideoTiming(decoded));
  const restored={mimeType:'video/mp4',videoFrames:validated};
  r.registerVideoTiming(restored,r.getVideoTiming(validated));
  assert.ok(restored.videoFrames.every(f=>r.hasMeasuredFrameTime(f)));
  assert.equal(r.getVideoTiming(restored).durationSeconds,2);
});
test('callers cannot mutate the registered evidence through the input or returned object', () => {
  const r=registry(),ref=reference(),input={...timing,sampleSeconds:[0,1]};
  r.registerVideoTiming(ref,input);input.sampleSeconds[0]=0.3;
  const saved=r.getVideoTiming(ref);
  assert.equal(saved.sampleSeconds[0],0);
  assert.ok(Object.isFrozen(saved));assert.ok(Object.isFrozen(saved.sampleSeconds));
});
