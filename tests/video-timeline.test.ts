import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { timelineIntent, resolveTimelineSource } from "../lib/video-timeline/intent";
import { bindTimelineFrames, validateObservations } from "../lib/video-timeline/observations";
import { runVideoTimeline, selectTimelineEvents } from "../lib/video-timeline/service";
import { registerVideoTiming } from "../lib/uploads/video-timing";
import { extractFramesFromPrivateVideo, probeTimelineDuration } from "../lib/uploads/server-video-frame-recovery";
import type { Message } from "../lib/types/chat";
const exec = promisify(execFile);
const video = {id:"attachment",chatId:"source",actorId:"actor",fileName:"same.mp4",mimeType:"video/mp4"};

test("media-relative intent is bounded and needs an actual source, never a project timeline", () => {
  assert.equal(timelineIntent("build a project timeline"),null);
  assert.equal(timelineIntent("What first appeared in the document?"),null);
  assert.equal(timelineIntent("When did the error first appear?")?.query,"error");
  assert.deepEqual(timelineIntent("What happened in the last30seconds?"),{kind:"tail",tail:30});
  assert.deepEqual(timelineIntent("What happened between00:20 and00:45?"),{kind:"range",start:20,end:45});
  for (const text of ["between 20 and 10", "between 00:70 and 01:30", "between -1 and 5"]) assert.ok(timelineIntent(text)?.error,text);
  assert.equal(timelineIntent("between 01:02:03 and 01:02:04")?.start,3723);
  const history = [{role:"user",attachments:[video]}] as Message[];
  assert.equal(resolveTimelineSource("What happened in the last30seconds?",[],[video],history).source?.id,video.id);
  assert.equal(resolveTimelineSource("first observed",[],[],[]).source,undefined);
  assert.ok(resolveTimelineSource("same.mp4",[],[video,{...video,id:"other"}],history).clarification);
  assert.equal(resolveTimelineSource("build a timestamped timeline",[{...video,id:"fresh"}],[video],history).source?.id,"fresh");
  assert.equal(resolveTimelineSource("build a timestamped timeline",[{...video,mimeType:"text/plain"}],[video],history).source,undefined);
});

test("structured observations cannot invent times, source metadata, identities or measured provenance", () => {
  const frames = [{timestampSeconds:0,dataUrl:"a"},{timestampSeconds:29,dataUrl:"b"}];
  assert.throws(()=>bindTimelineFrames(frames,0,30,"a".repeat(64)),/Measured/);
  registerVideoTiming(frames,{version:1,durationSeconds:30,sampleSeconds:[0,29]});
  const evidence = bindTimelineFrames(frames,0,30,"a".repeat(64));
  const report = (extra={})=>JSON.stringify({observations:[{description:"An error is visible",frame_ids:evidence.map(f=>f.id),...extra}],partial:false});
  const result = validateObservations(report(),evidence);
  const duplicate = JSON.parse(report());duplicate.observations.push(duplicate.observations[0]);
  assert.throws(()=>validateObservations(JSON.stringify(duplicate),evidence),/Duplicate event/);
  assert.throws(()=>validateObservations(report(),[{...evidence[0],seconds:NaN}]),/Invalid structured/);
  assert.equal(result.events[0].observed_start,0); assert.equal(result.events[0].observed_end,29);
  for (const raw of [report({observed_start:3}),report({frame_ids:["foreign"]}),report({source_chat_id:"forged"}),report({frame_ids:[evidence[0].id,evidence[0].id]}),"{}","not JSON",JSON.stringify({observations:[],partial:false}), report({description:"I cannot inspect this footage"})]) assert.throws(()=>validateObservations(raw,evidence));
  assert.equal(validateObservations(JSON.stringify({observations:[{description:"An error is visible",frame_ids:[evidence[0].id]}],partial:true}),evidence).partial,true);
  frames[0].timestampSeconds=1;
  assert.throws(()=>bindTimelineFrames(frames,0,30,"a".repeat(64)),/Measured/);
});

test("cached runtime retrieves ending/earliest observations and filters real samples, with zero media calls",async()=>{
  const frames=[{id:"early",seconds:2,sha256:"a".repeat(64)},{id:"end",seconds:59.9,sha256:"b".repeat(64)}];
  const windows=[{requested_start:0,requested_end:30,duration:60,status:"complete",events:[{description:"error visible",frame_ids:["early"],observed_start:2,observed_end:2}],frames:[frames[0]],failure:null,model:"configured-model",lease_until:""},
    {requested_start:30,requested_end:60,duration:60,status:"partial",events:[{description:"error at ending",frame_ids:["end"],observed_start:59.9,observed_end:59.9}],frames:[frames[1]],failure:null,model:"configured-model",lease_until:""}];
  let paid=0;
  const deps={client:()=>({rpc:async(name:string,args:Record<string,unknown>)=>{assert.ok(["read_video_timeline","search_video_timeline_events"].includes(name));return {data:name === "search_video_timeline_events" ? selectTimelineEvents(windows,Number(args.p_start),Number(args.p_end),String(args.p_query ?? "")) : windows,error:null};}}),source:async()=>({fingerprint:"a".repeat(64)}),decode:async()=>{paid++;throw Error("no decode");},probe:async()=>{paid++;throw Error("no probe");}} as unknown as NonNullable<Parameters<typeof runVideoTimeline>[1]>;
  const first=await runVideoTimeline({actorId:"actor",chatId:"current",source:video,intent:{kind:"first",query:"error"},providers:[]},deps);
  assert.match(first,/"observed_start":2/); assert.doesNotMatch(first,/error at ending/);
  const tail=await runVideoTimeline({actorId:"actor",chatId:"current",source:video,intent:{kind:"tail",tail:30},providers:[]},deps);
  assert.match(tail,/error at ending/);assert.match(tail,/"window_status":"partial"/);assert.match(tail,/never proven onset/);assert.equal(paid,0);
  const span={...windows[0],frames,events:[{description:"same sampled scene",frame_ids:["early","end"],observed_start:2,observed_end:59.9}]};
  assert.equal(selectTimelineEvents([span],20,40).length,0,"a numeric span is not continuous observed evidence");
});

test("bundled decoder selects beginning and true ending at low FPS, and tail positions within last 30s",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"timeline-fixture-"));
  const ffmpeg=join(process.cwd(),"node_modules/@ffmpeg-installer/linux-x64/ffmpeg");
  const before=(await readdir(tmpdir())).filter(n=>n.startsWith("katie-video-"));
  try {
    const path=join(dir,"changes.mp4");
    await exec(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:s=64x48:r=1:d=59","-f","lavfi","-i","color=c=red:s=64x48:r=1:d=1","-filter_complex","[0:v][1:v]concat=n=2:v=1:a=0[v]","-map","[v]","-c:v","mpeg4","-y",path]);
    const source=new Blob([new Uint8Array(await readFile(path))]);
    assert.equal(await probeTimelineDuration(source),60);
    const first=await extractFramesFromPrivateVideo(source,{window:{start:0,end:30}});
    assert.equal(first[0].timestampSeconds,0); assert.equal(first.at(-1)!.timestampSeconds,29);
    const tail=await extractFramesFromPrivateVideo(source,{window:{start:30,end:60}});
    assert.equal(tail[0].timestampSeconds,30); assert.equal(tail.at(-1)!.timestampSeconds,59);
    assert.equal(new Set(tail.map(f=>f.timestampSeconds)).size,tail.length);
    const pixel=await sharp(Buffer.from(tail.at(-1)!.dataUrl.split(",")[1],"base64")).raw().toBuffer();
    assert.ok(pixel[0]>pixel[2]*2,"actual final event is red");
    assert.equal(bindTimelineFrames(tail,30,60,"a".repeat(64)).at(-1)!.seconds,59);
    await assert.rejects(extractFramesFromPrivateVideo(source,{window:{start:0,end:31}}),/30 seconds/);
    await assert.rejects(extractFramesFromPrivateVideo(source,{window:{start:59,end:61}}),/in-source/);
    await assert.rejects(extractFramesFromPrivateVideo(new Blob(["bad"]),{window:{start:0,end:1}}),/trusted/);
    const vfrPath=join(dir,"vfr.mp4");
    await exec(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:s=64x48:r=10:d=4","-vf","select='eq(n,0)+eq(n,1)+eq(n,7)+eq(n,12)+eq(n,22)+eq(n,39)'","-vsync","vfr","-c:v","mpeg4","-y",vfrPath]);
    const vfr=new Blob([new Uint8Array(await readFile(vfrPath))]);
    const vfrDuration=await probeTimelineDuration(vfr);
    assert.ok(vfrDuration !== null);
    const vfrFrames=await extractFramesFromPrivateVideo(vfr,{window:{start:0,end:vfrDuration!}});
    const known=[0,0.1,0.7,1.2,2.2,3.9];
    assert.ok(vfrFrames.every(f=>known.some(t=>Math.abs(t-f.timestampSeconds)<0.0001)),"VFR evidence uses actual source PTS, never requested seek times");
    assert.equal(vfrFrames[0].timestampSeconds,0);assert.equal(vfrFrames.at(-1)!.timestampSeconds,3.9);
    // MPEG-TS has nonzero origin: explicit unsupported handling, never a guessed endpoint.
    const tsPath=join(dir,"offset.ts");
    await exec(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:s=64x48:r=2:d=3","-c:v","mpeg2video","-y",tsPath]);
    const offset=new Blob([new Uint8Array(await readFile(tsPath))]);
    assert.equal(await probeTimelineDuration(offset),null);
    await assert.rejects(extractFramesFromPrivateVideo(offset,{window:{start:0,end:2}}),/zero-origin/);
  } finally {await rm(dir,{recursive:true,force:true});}
  assert.deepEqual((await readdir(tmpdir())).filter(n=>n.startsWith("katie-video-")),before,"temporary directories cleaned on success and failure");
});

test("runtime provider inference is receipt-first, bounded, and failed accepted calls do not retry",async()=>{
  const frames=[{timestampSeconds:0,dataUrl:"first"},{timestampSeconds:29,dataUrl:"last"}];
  registerVideoTiming(frames,{version:1,durationSeconds:30,sampleSeconds:[0,29]});
  let state:Record<string,unknown>|null=null, calls=0, decodes=0;
  const order:string[]=[];
  const client={rpc:async(name:string,args:Record<string,unknown>)=>{
    order.push(name);
    if(name==="read_video_timeline")return {data:state?[state]:[],error:null};
    if(name==="claim_video_timeline"){
      if(state)return {data:false,error:null};
      state={requested_start:0,requested_end:30,duration:30,status:"processing",events:null,frames:null,lease_until:new Date().toISOString()};return {data:true,error:null};
    }
    if(name==="finish_video_timeline"){
      Object.assign(state!,{status:args.p_failure?"failed":"complete",failure:args.p_failure,frames:args.p_frames,events:args.p_events,model:args.p_model});return {data:true,error:null};
    }
    if(name==="search_video_timeline_events") return {data:[],error:null};
    throw Error(name);
  }};
  const provider={name:"grok",listModels:async()=>["grok-4-configured"],generate:async()=>{calls++;assert.ok(state);assert.ok(order.includes("claim_video_timeline"));throw Error("response lost after acceptance");}} as unknown as Parameters<typeof runVideoTimeline>[0]["providers"][0];
  const deps={client:()=>client,source:async()=>({fingerprint:"a".repeat(64),source:new Blob(["private"])}),probe:async()=>30,decode:async()=>{decodes++;return frames;}} as unknown as NonNullable<Parameters<typeof runVideoTimeline>[1]>;
  const input={actorId:"actor",chatId:"current",source:video,intent:{kind:"build" as const},providers:[provider]};
  const failed=await runVideoTimeline(input,deps);
  assert.match(failed,/provider outcome ambiguous/);assert.equal(calls,1);assert.equal(decodes,1);
  const cached=await runVideoTimeline(input,deps);
  assert.match(cached,/"status":"failed"/);assert.equal(calls,1);assert.equal(decodes,1);
});

test("canonical retained source rejects forged actors, missing originals and changed fingerprints without a provider",async()=>{
  const {createStoredUploadService}=await import("../lib/uploads/stored-uploads");
  const {createHash}=await import("node:crypto");
  const actor="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",chat="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",id="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const source=new Blob(["retained original"]);
  const fingerprint=createHash("sha256").update("retained original").digest("hex");
  const record={actorId:actor,hasSource:true,sourceFingerprint:fingerprint,reference:{mimeType:"video/mp4"}};
  let originalReads=0;
  const objects={exists:async()=>({data:true,error:null}),download:async(path:string)=>{
    if(path.endsWith(".json"))return {data:new Blob([JSON.stringify(record)]),error:null};
    originalReads++;return {data:source,error:null};
  }};
  const storage={from:()=>objects} as unknown as Parameters<typeof createStoredUploadService>[0];
  const service=createStoredUploadService(storage,"offline-secret");
  assert.equal((await service.timelineSource(chat,id,actor)).fingerprint,fingerprint);assert.equal(originalReads,1);
  await assert.rejects(service.timelineSource(chat,id,"wrong-actor"),/Verified retained video/);
  record.sourceFingerprint="b".repeat(64);
  await assert.rejects(service.timelineSource(chat,id,actor),/fingerprint changed/);
  record.hasSource=false;
  await assert.rejects(service.timelineSource(chat,id,actor),/Verified retained video/);
});
