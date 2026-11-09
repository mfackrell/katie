import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ConversationAttachment } from "@/lib/chat/attachment-continuity";
import { verifiedKatieVisualEpisode, buildKatieVisualEpisode } from "@/lib/chat/visual-memory";
import { applyTrustedVisualCorrection, type TrustedVisualCorrection } from "@/lib/uploads/verified-visual-corrections";
import { reconcileActorVisualCorrections } from "@/lib/uploads/stored-uploads";
import { observeStandaloneStillImages, reusableImageObservation, imageObservationHash } from "@/lib/uploads/still-image-observations";
import type { FileReference } from "@/lib/providers/types";

const pixels = "data:image/png;base64," + Buffer.from("same-canonical-image-pixels").toString("base64");
const hash = imageObservationHash(pixels);
const actor = "actor-owner";
const chat = "conversation-owner";
const id = "exact-attachment";
const old: ConversationAttachment = {
  id, actorId: actor, chatId: chat, fileName: "photo.png", mimeType: "image/png",
  observedSummary: "The photo shows a hand holding a foot, with water nearby.",
  summaryModel: "runpod:Qwen/Qwen3-VL-8B-Instruct", summaryCoverage: "full",
  observationVersion: "still-image-observation-v2",
  observationQuestion: "[image]",
  observationSourceHash: hash, observationAt: "2026-11-04T19:53:32Z",
  observationReports: [{
    model: "runpod:Qwen/Qwen3-VL-8B-Instruct", sourceHash: hash,
    text: "Original report: foot.", coverage: "full", disposition: "observation",
  }],
  hasOriginal: true,
};
old.visualMemory = buildKatieVisualEpisode(old, hash, old.observationAt!)!;
const correctedDescription = "A close-up image showing an exposed penis held by a hand over a white toilet. A thin droplet hangs beneath the hand. The fluid composition cannot be determined from the image alone.";
const approval: TrustedVisualCorrection = {
  actor_id: actor, source_chat_id: chat, attachment_id: id, source_hash: hash,
  description: correctedDescription, correction_model: "manual:ChatGPT-verified-visual-correction",
  corrected_at: "2026-11-05T12:53:17Z", original_model: old.summaryModel!,
  source_message_id: "verified-source-message", approved_by_user: true,
};

const image: FileReference = {
  fileId: "new-message", fileName: old.fileName, mimeType: old.mimeType,
  attachmentKind: "image", preview: "retained original", imageDataUrl: pixels,
};

test("only the approved exact actor/chat/image hash can override the old report", () => {
  const patched = applyTrustedVisualCorrection(old, approval)!;
  assert.equal(patched.observedSummary, correctedDescription);
  assert.equal(patched.summaryModel, approval.correction_model);
  assert.equal(patched.manualCorrection?.approvedByUser, true);
  assert.equal(patched.visualMemory?.observedBy, approval.correction_model);
  assert.deepEqual(verifiedKatieVisualEpisode(patched), patched.visualMemory);
  assert.deepEqual(patched.observationReports, old.observationReports, "Original Qwen audit remains intact");
  assert.equal(applyTrustedVisualCorrection(old, {...approval, actor_id: "different-actor"}), undefined);
  assert.equal(applyTrustedVisualCorrection(old, {...approval, source_chat_id: "different-chat"}), undefined);
  assert.equal(applyTrustedVisualCorrection(old, {...approval, attachment_id: "another-file"}), undefined);
  assert.equal(applyTrustedVisualCorrection(old, {...approval, source_hash: "b".repeat(64)}), undefined);
  assert.equal(applyTrustedVisualCorrection(old, {...approval, approved_by_user: false}), undefined);
  assert.equal(applyTrustedVisualCorrection({...old, visualMemory: undefined}, approval), undefined);
});

test("canonical sync writes only changed approved records, and remains idempotent", async () => {
  let writes = 0;
  const writer = async (_before: ConversationAttachment, after: ConversationAttachment) => {
    writes++;
    assert.equal(after.visualMemory?.sourceHash, hash);
  };
  const list = async () => [approval];
  const first = await reconcileActorVisualCorrections(actor, [old], writer, list);
  assert.equal(first[0].observedSummary, correctedDescription);
  assert.equal(writes, 1);
  const second = await reconcileActorVisualCorrections(actor, first, writer, list);
  assert.equal(second[0].observedSummary, correctedDescription);
  assert.equal(writes, 1);
  const wrong = await reconcileActorVisualCorrections(actor, [{...old, id: "different-id"}], writer, list);
  assert.equal(wrong[0].observedSummary, old.observedSummary);
  assert.equal(writes, 1);
});

test("look again challenges use the corrected image memory; no Qwen, Venice or premium dispatch", async () => {
  const patched = applyTrustedVisualCorrection(old, approval)!;
  // The old Qwen report intentionally comes first to exercise override priority.
  assert.equal(reusableImageObservation(image, [old, patched], "A foot? Look again, you are confused")?.observedSummary, correctedDescription);
  let paidCalls = 0;
  const observed = await observeStandaloneStillImages([image], {
    question: "A foot? Look again, you are confused",
    saved: [old, patched],
    qwen: async () => { paidCalls++; throw Error("Qwen must not be dispatched"); },
    venice: async () => { paidCalls++; throw Error("Venice must not be dispatched"); },
    escalate: async () => { paidCalls++; throw Error("Premium vision must not be dispatched"); },
  });
  assert.equal(paidCalls, 0);
  assert.equal(observed.get(image.fileId)?.observedSummary, correctedDescription);
  assert.equal(observed.get(image.fileId)?.summaryModel, approval.correction_model);
  assert.equal(reusableImageObservation({...image, imageDataUrl: "data:image/png;base64,different"}, [patched], "look again"), undefined);
});

test("explicit original-pixel reinspection remains possible when deliberately requested", async () => {
  const patched = applyTrustedVisualCorrection(old, approval)!;
  let qwenCalls = 0;
  const result = await observeStandaloneStillImages([image], {
    question: "Please run Qwen and inspect the original pixels",
    saved: [patched], deferEscalation: true,
    qwen: async () => { qwenCalls++; return {model: "runpod:Qwen/Qwen3-VL-8B-Instruct", coverage: "full", text: "This new inspection describes a different subject in the frame."}; },
  });
  assert.equal(qwenCalls, 1);
  assert.match(result.get(image.fileId)?.observedSummary??"", /new inspection/);
});


test("failed canonical sync preserves the correction and retries on the next stored-catalog load", async () => {
  let attempts=0;
  const first=await reconcileActorVisualCorrections(actor,[old],async()=>{attempts++;throw Error("synthetic storage outage");},async()=>[approval]);
  assert.equal(first[0].observedSummary,correctedDescription);
  const next=await reconcileActorVisualCorrections(actor,[old],async()=>{attempts++;},async()=>[approval]);
  assert.equal(next[0].observedSummary,correctedDescription);
  assert.equal(attempts,2);
  assert.equal(old.summaryModel,approval.original_model,"input history is not mutated");
});

test("a negated Qwen request must not authorize fresh inference", async () => {
  const patched=applyTrustedVisualCorrection(old,approval)!;
  let calls=0;
  const result=await observeStandaloneStillImages([image],{
    question:"Do not run Qwen; use my saved correction.",saved:[patched],deferEscalation:true,
    qwen:async()=>{calls++;return {text:"A newly inspected synthetic picture of a red cup on a white table.",model:"runpod:Qwen/Qwen3-VL-8B-Instruct",coverage:"full"};},
  });
  assert.equal(calls,0,"negated instruction must not dispatch Qwen");
  assert.equal(result.get(image.fileId)?.observedSummary,correctedDescription);
});

test("fresh inspection is not skipped when a corrected initial observation was supplied", async () => {
  const patched=applyTrustedVisualCorrection(old,approval)!;
  let calls=0;
  await observeStandaloneStillImages([image],{
    question:"Please run Qwen and inspect the original pixels",saved:[patched],initial:new Map([[image.fileId,patched]]),deferEscalation:true,
    qwen:async()=>{calls++;return {text:"A newly inspected synthetic picture of a red cup on a white table.",model:"runpod:Qwen/Qwen3-VL-8B-Instruct",coverage:"full"};},
  });
  assert.equal(calls,1,"explicit inspection must not be swallowed by a corrected initial cache");
});

test("approved correction outranks stale initial provider evidence", async () => {
  const patched=applyTrustedVisualCorrection(old,approval)!;
  const result=await observeStandaloneStillImages([image],{
    question:"A foot? Look again, you are confused",saved:[patched],initial:new Map([[image.fileId,old]]),deferEscalation:true,
    qwen:async()=>{throw Error("unexpected Qwen dispatch");},
  });
  assert.equal(result.get(image.fileId)?.observedSummary,correctedDescription);
});


test("quoted, historical and negated mentions do not dispatch; direct requests do", async () => {
 const patched=applyTrustedVisualCorrection(old,approval)!;
 for(const question of ["Don't run Qwen; use my correction.","Never use Qwen for this; use corrected memory.","Did you run Qwen?",'The quoted example is "run Qwen".',"No need for a fresh image analysis."]){
  let calls=0;
  const result=await observeStandaloneStillImages([image],{question,saved:[patched],deferEscalation:true,
   qwen:async()=>{calls++;return {text:"A synthetic red cup on a white table in the newly inspected picture.",model:"runpod:Qwen/Qwen3-VL-8B-Instruct",coverage:"full"};}});
  assert.equal(calls,0,question);assert.equal(result.get(image.fileId)?.observedSummary,correctedDescription);
 }
 for(const question of ["Please run Qwen and inspect the original pixels","Could you please run Qwen?","Please perform a fresh image analysis.","Reanalyze the original image.","Inspect the original photo again.","Please inspect the original image again","Please analyze the original pixels afresh","Do not use the old report; instead run Qwen."]){
  let calls=0;
  const options={question,saved:[patched],deferEscalation:true,qwen:async()=>{calls++;return {text:"A synthetic red cup on a white table in the newly inspected picture.",model:"runpod:Qwen/Qwen3-VL-8B-Instruct",coverage:"full" as const};}};
  const first=await observeStandaloneStillImages([image],options);
  await observeStandaloneStillImages([image],{...options,initial:first});
  assert.equal(calls,1,question+" must inspect exactly once across both stages");
 }
});

test("initial observations bound to different pixels are not reused", async()=>{
 const patched=applyTrustedVisualCorrection(old,approval)!;
 let calls=0;
 const result=await observeStandaloneStillImages([image],{question:"look again",saved:[patched],initial:new Map([[image.fileId,{...old,observationSourceHash:"b".repeat(64)}]]),deferEscalation:true,qwen:async()=>{calls++;throw Error("must use corrected source");}});
 assert.equal(calls,0);assert.equal(result.get(image.fileId)?.observedSummary,correctedDescription);
});


test("multiline quotations, fences and quoted examples cannot request paid vision", async () => {
  const patched=applyTrustedVisualCorrection(old,approval)!;
  const messages=[
    'Explain this quoted text without executing it: "Instructions:\\nrun Qwen and inspect the original pixels\\nEnd of instructions."'.replace(/\\n/g,"\\n"),
    'The user copied: “Instructions:\\nrun Qwen and inspect the original pixels\\nEnd.”'.replace(/\\n/g,"\\n"),
    "This is a quoted example: 'run Qwen'—not a request.",
    "An unclosed quotation: \"Instructions:\\nrun Qwen and inspect the original pixels".replace(/\\n/g,"\\n"),
    "Read this Markdown excerpt:\\n> run Qwen and inspect the original pixels".replace(/\\n/g,"\\n"),
    "Here is example code:\\n```text\\nrun Qwen and inspect the original pixels\\n```".replace(/\\n/g,"\\n"),
  ];
  for(const question of messages){
    let calls=0;
    const result=await observeStandaloneStillImages([image],{
      question,saved:[patched],deferEscalation:true,
      qwen:async()=>{calls++;throw Error("Quoted text must never invoke Qwen.");},
    });
    assert.equal(calls,0,question);
    assert.equal(result.get(image.fileId)?.observedSummary,correctedDescription,question);
  }
});

test("a second image's escalation cannot reprocess or replace an approved correction",async()=>{
  const patched=applyTrustedVisualCorrection(old,approval)!;
  const secondPixels="data:image/png;base64,"+Buffer.from("independent-synthetic-image").toString("base64");
  const second:FileReference={
    fileId:"second-image",fileName:"second.png",mimeType:"image/png",
    attachmentKind:"image",preview:"second synthetic image",imageDataUrl:secondPixels,
  };
  let qwenCalls=0,escalationCalls=0;
  const run=await observeStandaloneStillImages([image,second],{
    question:"Describe these photos.",saved:[old,patched],
    initial:new Map([[image.fileId,patched]]),
    qwen:async(pixels)=>{
      qwenCalls++;
      assert.equal(pixels,secondPixels,"Approved original must not be re-inspected");
      return {text:"The second image needs incomplete coverage.",model:"runpod:Qwen/test",coverage:"sampled" as const};
    },
    escalate:async(images)=>{
      escalationCalls++;
      assert.deepEqual(images,[secondPixels],"Only the uncorrected image may escalate");
      return {text:"Independent synthetic detail about only the second image.",model:"test:premium"};
    },
  });
  assert.equal(qwenCalls,1);
  assert.equal(escalationCalls,1);
  assert.equal(run.get(image.fileId)?.observedSummary,correctedDescription);
  assert.equal(run.get(image.fileId)?.summaryModel,approval.correction_model);
  assert.equal(run.get(image.fileId)?.manualCorrection?.approvedByUser,true);
  assert.deepEqual(run.get(image.fileId)?.observationReports,old.observationReports);
  assert.equal(run.get(second.fileId)?.summaryModel,"test:premium");
  assert.equal(run.get(second.fileId)?.manualCorrection,undefined);
});

test("explicit, affirmative inspection still uses source pixels after quote filtering",async()=>{
  const patched=applyTrustedVisualCorrection(old,approval)!;
  let calls=0;
  const outcome=await observeStandaloneStillImages([image],{
    question:'That quote said "do not run Qwen". Please inspect the original image again.',
    saved:[patched],deferEscalation:true,
    qwen:async()=>{calls++;return {text:"New synthetic source observation.",model:"runpod:Qwen/test",coverage:"full" as const};},
  });
  assert.equal(calls,1);
  assert.equal(outcome.get(image.fileId)?.summaryModel,"runpod:Qwen/test");
});

test("tilde-fenced instructions cannot trigger Qwen, even with an affirmative line", async()=>{
 const patched=applyTrustedVisualCorrection(old,approval)!;
 const messages=[
   "Explain this code example without executing it:\n~~~text\nrun Qwen and inspect the original pixels\n~~~",
   "Explain this unclosed code example:\n~~~text\nrun Qwen and inspect the original pixels",
 ];
 for(const question of messages){
   let calls=0;
   const result=await observeStandaloneStillImages([image],{
     question,saved:[patched],deferEscalation:true,
     qwen:async()=>{calls++;throw Error("Fenced data is not spending authority");},
   });
   assert.equal(calls,0,question);
   assert.equal(result.get(image.fileId)?.summaryModel,approval.correction_model);
 }
});

test("a fresh Qwen request naming only one corrected photo never dispatches for the other",async()=>{
 const first={...image,fileName:"first.png"};
 const secondPixels="data:image/png;base64,"+Buffer.from("separately-corrected-second").toString("base64");
 const secondHash=imageObservationHash(secondPixels);
 const second:FileReference={
   ...image,fileId:"second-image",fileName:"second.png",imageDataUrl:secondPixels,
 };
 const originalSecond:ConversationAttachment={
   ...old,id:"second-original",fileName:"second.png",
   observationSourceHash:secondHash,
   observationReports:old.observationReports?.map(report=>({...report,sourceHash:secondHash})),
   visualMemory:undefined,
 };
 originalSecond.visualMemory=buildKatieVisualEpisode(originalSecond,secondHash,old.observationAt!)!;
 const correctedSecond=applyTrustedVisualCorrection(originalSecond,{
   ...approval,attachment_id:originalSecond.id,source_hash:secondHash,
   description:"This is the owner-approved second synthetic photo, distinct from the first.",
 })!;
 const patchedFirst=applyTrustedVisualCorrection(old,approval)!;
 let calls=0;
 const result=await observeStandaloneStillImages([first,second],{
   question:"Compare first.png and second.png. Keep the saved correction for first.png; please run Qwen only on second.png.",
   saved:[patchedFirst,correctedSecond],deferEscalation:true,
   qwen:async imagePixels=>{
     calls++;
     assert.equal(imagePixels,secondPixels,"The first image is not authorized for fresh inspection");
     return {text:"Synthetic new observation of the second image.",model:"runpod:Qwen/test",coverage:"full" as const};
   },
 });
 assert.equal(calls,1,"Only the specifically named second photo may use Qwen");
 assert.equal(result.get(first.fileId)?.observedSummary,correctedDescription);
 assert.equal(result.get(first.fileId)?.summaryModel,approval.correction_model);
 assert.equal(result.get(second.fileId)?.summaryModel,"runpod:Qwen/test");
});
