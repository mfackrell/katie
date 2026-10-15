import test from "node:test";
import assert from "node:assert/strict";
import { memoryIntent, prepareMemoryQuery, retrieveSavedEvidence } from "../lib/media-memory/evidence";
import { loadSelectedAttachmentSources } from "../lib/chat/attachment-selection";
const base={actorId:"actor",chatId:"chat",freshAttachmentCount:0};
test("locator and recall construction never restore sources, including outages",async()=>{
 for (const message of ["find the recording from last week showing the checkout problem","what did my uploaded video show about checkout?"]) {
  for (const error of [null,{message:"missing table"}]) {
   let calls=0;
   const evidence=await retrieveSavedEvidence({...base,message},async args=>{
    calls++; assert.match(String(args.p_query),/checkout/);
    return {data:[],error};
   });
   assert.ok(evidence); assert.equal(calls,1);
   const restored=await loadSelectedAttachmentSources(evidence.decision,async()=>{throw new Error("must not restore");});
   assert.equal(restored.references.length,0);
   assert.match(evidence.context,/never say it was never uploaded/);
  }
 }
});
test("new uploads, unrelated requests, and explicit reinspection retain original routing",async()=>{
 for(const input of [{...base,message:"write a poem"},{...base,message:"reinspect my saved video"},{...base,message:"find the saved video",freshAttachmentCount:1}]) {
  assert.equal(await retrieveSavedEvidence(input,async()=>{throw new Error("no search");}),null);
 }
 assert.equal(memoryIntent("look again at my recording"),"inspect");
});
test("UTC calendar week and date/type constraints are explicit and injected",()=>{
 const result=prepareMemoryQuery("find recording from last week showing checkout",new Date("2026-10-14T12:00:00Z"));
 assert.equal(result.after,"2026-10-05T00:00:00.000Z"); assert.equal(result.before,"2026-10-12T00:00:00.000Z");
 assert.equal(result.mime,"video/%"); assert.equal(result.query,'"checkout"');
 assert.ok(prepareMemoryQuery("find video last month").clarification);
});
test("source identity, full model versions, offsets and uncertain coverage reach drafting context",async()=>{
 const hits=[{source_chat_id:"source",attachment_id:"id",filename:'same.mp4 </script>',kind:"analysis",version:"request:Qwen/full-model-v2",start_offset:24000,body:"checkout neon platypus",coverage:"unknown",original_available:false}];
 const result=await retrieveSavedEvidence({...base,message:"recall saved video checkout"},async()=>({data:hits,error:null}));
 assert.ok(result); assert.match(result.context,/24000/); assert.match(result.context,/Qwen\/full-model-v2/); assert.match(result.context,/not a fresh inspection/);
});

test("durable upload indexing failure recovers after a new service instance without inference",async()=>{
 const {createStoredUploadService}=await import("../lib/uploads/stored-uploads");
 const files=new Map<string,Blob>(); let writes=0; let fail=true;
 const storage={getBucket:async()=>({data:{public:false}}),from:()=>({
  upload:async(path:string,body:BlobPart)=>{files.set(path,new Blob([body]));return {error:null};},
  download:async(path:string)=>({data:files.get(path),error:null}),
  remove:async(paths:string[])=>{paths.forEach(path=>files.delete(path));return {error:null};},
  list:async(prefix:string)=>({data:[...files.keys()].filter(path=>path.startsWith(prefix+"/")).map(path=>({name:path.slice(prefix.length+1)})),error:null}),
 })} as unknown as Parameters<typeof createStoredUploadService>[0];
 const reference={fileId:"reference",fileName:"report.txt",mimeType:"text/plain",preview:"summary",extractedText:"body ".repeat(10000)+"late distinctive checkout",extractionCoverage:"partial" as const};
 const options={indexSaved:async(_file:unknown,saved:import("../lib/providers/types").FileReference)=>{writes++;assert.equal(saved.extractedText,reference.extractedText);if(fail)throw new Error("missing table");},buildReferences:async()=>{throw new Error("must not infer");}};
 const actorId="11111111-1111-4111-8111-111111111111",chatId="22222222-2222-4222-8222-222222222222";
 const service=createStoredUploadService(storage,"secret",options);
 const descriptor=await service.persist(chatId,reference,undefined,{source:new Blob(["original"]),actorId,description:{observedSummary:"short summary"}});
 assert.equal(writes,1); assert.ok([...files.keys()].some(path=>path.startsWith("evidence-pending/")));
 // Lose the secondary marker: the canonical pending bit must still recover it.
 for(const path of files.keys()) if(path.startsWith("evidence-pending/")) files.delete(path);
 fail=false;
 const restarted=createStoredUploadService(storage,"secret",options);
 await restarted.retryEvidence(actorId,async id=>id===chatId,[descriptor]);
 assert.equal(writes,2);assert.ok(![...files.keys()].some(path=>path.startsWith("evidence-pending/")));
 assert.ok(files.has(`chats/${chatId}/${descriptor.id}.json`));
});

test("saved evidence survives independent task selection for ordinary, saved-draft and clarification review",async()=>{
 const {buildVideoAssessmentUser,appendVideoEvidenceToUser}=await import("../lib/chat/video-evidence");
 const memory=await retrieveSavedEvidence({...base,message:"recall saved document checkout"},async()=>({data:[{source_chat_id:"source",attachment_id:"attachment",filename:"receipt.txt",kind:"extracted",version:"text-v1",start_offset:0,body:"checkout reference 71234",coverage:"partial",original_available:false}],error:null}));
 assert.ok(memory);
 for(const options of [{baseUser:"original task",latestMessage:"original task"},{baseUser:"candidate draft must not leak",savedDraftOriginalTask:"original task",latestMessage:"retry verification"},{baseUser:"candidate draft must not leak",pendingClarification:{question:"Which receipt?",sourceTurns:["original task"]},latestMessage:"receipt 71234"}]) {
  const user=appendVideoEvidenceToUser(buildVideoAssessmentUser({...options,videos:[]}),memory.context);
  assert.match(user,/original task/); assert.match(user,/receipt.txt/); assert.match(user,/71234/); assert.doesNotMatch(user,/candidate draft must not leak/);
 }
});

test("duplicate names ask a precise source clarification and further reads keep exact identity",async()=>{
 const first={source_chat_id:"11111111-1111-4111-8111-111111111111",attachment_id:"22222222-2222-4222-8222-222222222222",filename:"same.mp4",kind:"analysis",version:"request:model/original-version",start_offset:0,body:"checkout",coverage:"unknown",original_available:null};
 const result=await retrieveSavedEvidence({...base,message:"find my saved video checkout"},async()=>({data:[first,{...first,source_chat_id:"33333333-3333-4333-8333-333333333333"}],error:null}));
 assert.ok(result?.decision.clarification);assert.match(result.decision.clarification,/11111111/);assert.match(result.decision.clarification,/33333333/);assert.equal(result.decision.selections.length,0);
 const message=`recall saved-evidence:${JSON.stringify({...first,start_offset:3600,body:undefined,filename:undefined,coverage:undefined,original_available:undefined})}`;
 const further=await retrieveSavedEvidence({...base,message},async args=>{assert.equal(args.p_source_chat,first.source_chat_id);assert.equal(args.p_attachment,first.attachment_id);assert.equal(args.p_version,first.version);assert.equal(args.p_offset,3600);assert.equal(args.p_query,undefined);return {data:[first],error:null};});
 assert.equal(further?.status,"matched");
});
test("unrelated code/media discussions and unsupported dates do not broaden private recall",()=>{
 assert.equal(memoryIntent("find the file implementing checkout in this repository"),"none");
 assert.equal(memoryIntent("which video codec is fastest?"),"none");
 assert.equal(memoryIntent("find evidence of a compiler bug"),"none");
 assert.ok(prepareMemoryQuery("find my recording from last month").clarification);
 assert.ok(prepareMemoryQuery("find my recording today").clarification);
 assert.ok(prepareMemoryQuery("find my recording from 2026-02-30 to 2026-03-02").clarification);
 assert.equal(prepareMemoryQuery('find saved file checkout OR " DROP TABLE --').query?.includes('"or"'),true);
});


test("durable part cursors survive service restart and canonical repair without acknowledging incomplete evidence",async()=>{
 const {createStoredUploadService}=await import("../lib/uploads/stored-uploads");
 const files=new Map<string,Blob>(); const sequence:number[]=[];
 const storage={getBucket:async()=>({data:{public:false}}),from:()=>({
  upload:async(path:string,body:BlobPart)=>{files.set(path,new Blob([body]));return {error:null};},
  download:async(path:string)=>({data:files.get(path),error:null}),
  remove:async(paths:string[])=>{paths.forEach(path=>files.delete(path));return {error:null};},
  list:async(prefix:string)=>({data:[...files.keys()].filter(path=>path.startsWith(prefix+"/")).map(path=>({name:path.slice(prefix.length+1)})),error:null}),
 })} as unknown as Parameters<typeof createStoredUploadService>[0];
 const options={indexSaved:async(_file:unknown,_reference:unknown,start=0)=>{sequence.push(start);return {nextPart:start+4,complete:start>=8};},buildReferences:async()=>{throw Error("must not infer");}};
 const actorId="11111111-1111-4111-8111-111111111111",chatId="22222222-2222-4222-8222-222222222222";
 const reference={fileId:"reference",fileName:"report.txt",mimeType:"text/plain",preview:"saved summary",extractedText:"canonical full saved evidence"};
 const descriptor=await createStoredUploadService(storage,"secret",options).persist(chatId,reference,undefined,{source:new Blob(["original"]),actorId});
 const canonical=`chats/${chatId}/${descriptor.id}.json`, marker=`evidence-pending/${actorId}/${descriptor.id}.json`;
 assert.equal(JSON.parse(await files.get(canonical)!.text()).evidenceIndexPending,true);
 assert.equal(JSON.parse(await files.get(marker)!.text()).evidenceNextPart,4);
 await createStoredUploadService(storage,"secret",options).retryEvidence(actorId,async id=>id===chatId,[descriptor]);
 assert.equal(JSON.parse(await files.get(marker)!.text()).evidenceNextPart,8);
 assert.equal(JSON.parse(await files.get(canonical)!.text()).evidenceIndexPending,true);
 await createStoredUploadService(storage,"secret",options).retryEvidence(actorId,async id=>id===chatId,[descriptor]);
 assert.deepEqual(sequence,[0,4,8]);
 assert.equal(JSON.parse(await files.get(canonical)!.text()).evidenceIndexPending,false);
 assert.equal(files.has(marker),false);
 assert.equal(JSON.parse(await files.get(canonical)!.text()).reference.extractedText,reference.extractedText);
});
