import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import sharp from 'sharp';
import { createStoredUploadService } from '../lib/uploads/stored-uploads';
import { createGeneratedImageService, generatedImageBytes } from '../lib/uploads/generated-image-service';
import { createGeneratedImageObserver } from '../lib/uploads/generated-image-observation';
import { loadSelectedAttachmentSources } from '../lib/chat/attachment-selection';
import { chooseImageFollowup, resolveImageFollowup, imageFollowupIntent, imageEditSourceUnavailable } from '../lib/chat/image-source-followup';
import { generatedImageId, originalImageHash } from '../lib/images/generated-source';
import { observeStandaloneStillImages, imageObservationAsText } from '../lib/uploads/still-image-observations';
import { verifiedKatieVisualEpisode, katieVisualMemoryContext } from '../lib/chat/visual-memory';
import { parseMessageContent, encodeMessageContent } from '../lib/data/persistence-store';
import type { Message } from '../lib/types/chat';
import type { ConversationAttachment } from '../lib/chat/attachment-continuity';

const actorId='11111111-1111-4111-8111-111111111111',chatId='22222222-2222-4222-8222-222222222222';
const messageId='33333333-3333-4333-8333-333333333333',laterId='44444444-4444-4444-8444-444444444444';
const createdAt='2026-11-16T12:00:00.000Z';
const facts='Primary focal point: a green square occupying the center. Detailed focal-point observations: the square has straight edges, consistent green color, a smooth flat surface and a simple rectangular outline. Spatial relationships and interactions: it sits against a plain white background without overlap or other objects. Secondary context: no person or text is visible. Uncertainties: a rendered image cannot establish real-world size or material.';
const image=async(color='green')=>'data:image/png;base64,'+(await sharp({create:{width:16,height:16,channels:3,background:color}}).png().toBuffer()).toString('base64');
function storage() {
  const files=new Map<string,Blob>(),writes:string[]=[];
  let failCatalog=false;
  const fake={getBucket:async()=>({data:{public:false},error:null}),createBucket:async()=>({data:{},error:null}),
    from:()=>({
      download:async(path:string)=>({data:files.get(path)??null,error:files.has(path)?null:{message:'missing'}}),
      upload:async(path:string,value:BlobPart,options?:{upsert?:boolean;contentType?:string})=>{
        if(failCatalog && path.startsWith('actor-catalog/'))return {error:{message:'catalog write interrupted'},data:null};
        if(files.has(path)&&options?.upsert!==true)return {error:{message:'duplicate',statusCode:'409'},data:null};
        writes.push(path);files.set(path,new Blob([value],{type:options?.contentType}));return{data:{},error:null};
      },
      list:async(prefix:string)=>({data:[...files.keys()].filter(p=>p.startsWith(prefix+'/')).map(p=>({name:p.slice(prefix.length+1)})),error:null}),
      remove:async(paths:string[])=>{paths.forEach(p=>files.delete(p));return {error:null};},
    })};
  const factory=()=>createStoredUploadService(fake as unknown as Parameters<typeof createStoredUploadService>[0],'offline-secret');
  const service=()=>{const s=factory();return createGeneratedImageService({persist:(...args)=>s.persistGenerated(...args),read:(...args)=>s.readGenerated(...args)});};
  return {files,writes,factory,service,set failCatalog(value:boolean){failCatalog=value;}};
}
async function generate(fake:ReturnType<typeof storage>,options:{url?:string;id?:string;parents?:Array<{attachmentId:string;sourceChatId:string}>;count?:number}={}) {
  return fake.service().retainResult({actorId,chatId,messageId:options.id??messageId,requestId:'generation-request',createdAt,
    provider:'google',model:'image-fixture',assets:Array.from({length:options.count??1},()=>({type:'image',url:options.url??''})).map(a=>({...a,url:options.url??''})),parents:options.parents});
}
function message(assets:Message['assets'],attachments:ConversationAttachment[]=[],id=messageId):Message {
  return {id,chatId,role:'assistant',model:'image-fixture',content:'[Image Generated]',createdAt,assets,attachments};
}
function decoded(source:Message):Message {const parsed=parseMessageContent(encodeMessageContent(source));return {...source,...parsed,content:parsed.text};}
function observer(fake:ReturnType<typeof storage>,qwen:(image:string)=>Promise<string>) {
  const s=fake.factory();
  return createGeneratedImageObserver({read:(...args)=>s.readGenerated(...args),update:(...args)=>s.updateImageObservation(...args),
    claim:(input,inspect)=>s.withGeneratedObservation(input,inspect),checkpoint:async(_key,run)=>run(),
    observe:(references,options)=>observeStandaloneStillImages(references,{...options,
      qwen:async pixels=>({text:await qwen(pixels),model:'runpod:Qwen/Qwen3-VL-8B-Instruct',coverage:'full'}),
      venice:async()=>{throw Error('Unexpected fallback');},escalate:async()=>{throw Error('Unexpected escalation');}})});
}
const choose=(history:Message[],catalog:ConversationAttachment[],text='What do you think of it?')=>chooseImageFollowup({message:text,history,catalog,actorId,chatId,freshCount:0});

test('generate -> persist -> reload -> Qwen inspection -> visual recall works without re-upload or inference during generation',async()=>{
  const fake=storage(),url=await image();
  const saved=await generate(fake,{url});
  const d=saved.attachments[0];
  assert.equal(d.conversationUsage,'generated');assert.equal(d.hasOriginal,true);
  assert.equal(d.visualMemory,undefined);assert.equal(d.observedSummary,undefined);
  assert.equal(d.generatedSource?.requestId,'generation-request');
  assert.equal(d.generatedSource?.sourceHash,originalImageHash(Buffer.from(url.split(',')[1],'base64')));
  assert.equal(saved.assets[0].attachmentId,d.id);assert.equal(saved.assets[0].url,url);
  const reloaded=decoded(message(saved.assets,saved.attachments));
  const decision=choose([reloaded],saved.attachments)!;assert.equal(decision.candidates[0].attachment?.id,d.id);
  const source=await fake.factory().readGenerated(actorId,chatId,d.id);
  let inspections=0;
  const inspect=observer(fake,async pixels=>{inspections++;assert.equal(pixels,source.reference.imageDataUrl);return facts;});
  const evidence=await inspect({actorId,chatId,requestId:'followup-claude',attachment:d,reference:source.reference,question:'What do you think of it?'});
  assert.equal(inspections,1);assert.ok(verifiedKatieVisualEpisode(evidence.descriptor));
  assert.match(imageObservationAsText(source.reference,evidence.observation).extractedText!,/green square/);
  assert.match(katieVisualMemoryContext([evidence.descriptor]),/KATIE_VISUAL_MEMORY/);
  // A provider switch cannot manufacture a new source or a new paid inspection.
  const second=await inspect({actorId,chatId,requestId:'followup-grok',attachment:d,reference:source.reference,question:'Does this look natural?'});
  assert.equal(inspections,1);assert.equal(second.descriptor.id,d.id);
});

test('concurrent registration of one output slot is idempotent and conflicting bytes cannot overwrite it',async()=>{
  const fake=storage(),url=await image();
  const [a,b]=await Promise.all([generate(fake,{url}),generate(fake,{url})]);
  assert.equal(a.attachments[0].id,b.attachments[0].id);
  assert.equal([...fake.files.keys()].filter(p=>p.endsWith('.source')).length,1);
  assert.equal(fake.writes.filter(p=>p.endsWith('.source')).length,1);
  const original=await fake.factory().readGenerated(actorId,chatId,a.attachments[0].id);
  // Direct persistence catches changed bytes even when caller attempts the same slot.
  await assert.rejects(fake.factory().persistGenerated(original.reference,new Blob(['different']),a.attachments[0].generatedSource!),/conflict/i);
  assert.equal((await fake.factory().readGenerated(actorId,chatId,a.attachments[0].id)).descriptor.generatedSource?.sourceHash,a.attachments[0].generatedSource?.sourceHash);
});

test('interrupted catalog registration repairs on replay without duplicate originals or regeneration',async()=>{
  const fake=storage(),url=await image();fake.failCatalog=true;
  await assert.rejects(generate(fake,{url}),/discovery|index/i);
  fake.failCatalog=false;
  const saved=await generate(fake,{url});
  assert.ok(fake.files.has(`actor-catalog/${actorId}/${saved.attachments[0].id}.json`));
  assert.equal(fake.writes.filter(p=>p.endsWith('.source')).length,1);
});

test('two independent follow-ups cannot pay for the same initial observation twice',async()=>{
  const fake=storage(),saved=await generate(fake,{url:await image()}),d=saved.attachments[0];
  const source=await fake.factory().readGenerated(actorId,chatId,d.id);
  let entered!:()=>void,finish!:()=>void,calls=0;
  const ready=new Promise<void>(r=>{entered=r;}),pending=new Promise<void>(r=>{finish=r;});
  const qwen=async()=>{calls++;entered();await pending;return facts;};
  const first=observer(fake,qwen)({actorId,chatId,requestId:'one',attachment:d,reference:source.reference,question:'What do you think of it?'});
  await ready;
  await assert.rejects(observer(fake,qwen)({actorId,chatId,requestId:'two',attachment:d,reference:source.reference,question:'Does this look natural?'}),/another saved request/);
  finish();await first;assert.equal(calls,1);
  await observer(fake,qwen)({actorId,chatId,requestId:'three',attachment:d,reference:source.reference,question:'How does it look?'});
  assert.equal(calls,1);
});

test('uncertain/crashed observation stays claimed by its original request, preserving pixels and replay recovery',async()=>{
  const fake=storage(),saved=await generate(fake,{url:await image()}),d=saved.attachments[0];
  const s=fake.factory();let transports=0,checkpoint:string|undefined;
  const input={actorId,chatId,id:d.id,requestId:'original-workflow',key:'question-one'};
  await assert.rejects(s.withGeneratedObservation(input,async()=>{transports++;checkpoint='saved provider output';throw Error('interrupted after checkpoint');}),/interrupted/);
  await assert.rejects(fake.factory().withGeneratedObservation({...input,requestId:'different-workflow'},async()=>{transports++;return 'must not run';}),/another saved request/);
  const resumed=await fake.factory().withGeneratedObservation(input,async()=>checkpoint!);
  assert.equal(resumed,'saved provider output');assert.equal(transports,1);
  assert.ok((await s.readGenerated(actorId,chatId,d.id)).source.size);
});

test('real source hashes prevent stale observations on edits and preserve an explicit version lineage',async()=>{
  const fake=storage(),first=await generate(fake,{url:await image('green')}),original=first.attachments[0];
  const second=await generate(fake,{url:await image('red'),id:laterId,parents:[{attachmentId:original.id,sourceChatId:chatId}]});
  const edited=second.attachments[0];
  assert.notEqual(edited.id,original.id);assert.notEqual(edited.generatedSource?.sourceHash,original.generatedSource?.sourceHash);
  assert.equal(edited.visualMemory,undefined);assert.equal(edited.generatedSource?.parents[0].attachmentId,original.id);
  const history=[message(first.assets,first.attachments),message(second.assets,second.attachments,laterId)],catalog=[original,edited];
  assert.equal(choose(history,catalog,'Use the second version.')?.candidates[0].attachment?.id,edited.id);
  assert.equal(choose(history,catalog,'Use the original image.')?.candidates[0].attachment?.id,original.id);
  assert.equal(choose(history,catalog,'Change her shirt.')?.operation,'edit');
  assert.equal(choose(history,catalog,'Change her shirt.')?.candidates[0].attachment?.id,edited.id);
});

test('multiple outputs require a choice, support ordinal/pinned selection, and reject nonexistent indices',async()=>{
  const fake=storage(),saved=await generate(fake,{url:await image(),count:2});
  const history=[message(saved.assets,saved.attachments)];
  assert.match(choose(history,saved.attachments)?.clarification??'',/Which one/);
  assert.equal(choose(history,saved.attachments,'Use the second version.')?.candidates[0].attachment?.id,saved.attachments[1].id);
  const selected=chooseImageFollowup({message:'Describe',history,catalog:saved.attachments,actorId,chatId,freshCount:0,pin:{messageId,assetIndex:1}});
  assert.equal(selected?.candidates[0].attachment?.id,saved.attachments[1].id);
  assert.ok(chooseImageFollowup({message:'Describe',history,catalog:saved.attachments,actorId,chatId,freshCount:0,pin:{messageId,assetIndex:4}})?.clarification);
});

test('an intervening upload wins; unrelated dialogue, new uploads and other actors never reopen a generated image implicitly',async()=>{
  const fake=storage(),saved=await generate(fake,{url:await image()}),d=saved.attachments[0];
  const uploaded={id:laterId,fileName:'uploaded.png',mimeType:'image/png',actorId,chatId,conversationUsage:'uploaded' as const};
  const turn:Message={id:'55555555-5555-4555-8555-555555555555',chatId,role:'user',createdAt,content:'This one?',attachments:[uploaded]};
  const history=[message(saved.assets,saved.attachments),turn];
  assert.equal(choose(history,[d,uploaded])?.candidates[0].attachment?.id,uploaded.id);
  assert.equal(choose(history,[d,uploaded],'What is the weather?'),null);
  assert.equal(choose([...history,{...turn,id:'unrelated',content:'How is business?',attachments:[]}],[d,uploaded]),null);
  assert.equal(chooseImageFollowup({message:'What do you think of it?',history,catalog:[d],actorId,chatId,freshCount:1}),null);
  await assert.rejects(fake.factory().readGenerated('66666666-6666-4666-8666-666666666666',chatId,d.id),/ownership/);
  let reads=0;
  const denial=await resolveImageFollowup({message:'Describe',history:[message(saved.assets,saved.attachments)],catalog:[d],actorId,chatId:'77777777-7777-4777-8777-777777777777',freshCount:0,pin:{messageId,assetIndex:0}},
    {registerLegacy:async()=>{reads++;return d;},read:async()=>{reads++;return d;}});
  assert.equal(reads,0);assert.equal(denial?.selections.length,0);
});

test('legacy assistant assets register only on demand; generation metadata is not a visual memory',async()=>{
  const fake=storage(),legacy=message([{type:'image',url:await image()}]);
  assert.equal(fake.files.size,0);
  const d=await fake.service().registerLegacy(actorId,chatId,legacy,0);
  assert.equal(d.generatedSource?.registration,'legacy-assistant-asset');
  assert.equal(d.generatedSource?.requestId,null);assert.equal(d.visualMemory,undefined);
  const again=await fake.service().registerLegacy(actorId,chatId,legacy,0);
  assert.equal(d.id,again.id);
  await assert.rejects(fake.service().registerLegacy(actorId,chatId,{...legacy,role:'user'},0),/verified/);
});

test('expired provider URLs use retained originals; missing originals never silently substitute another image',async()=>{
  const fake=storage(),saved=await generate(fake,{url:await image()}),d=saved.attachments[0];
  const resumed=await generate(fake,{url:'https://imgen.x.ai/expired'});
  assert.equal(resumed.assets[0].url,saved.assets[0].url);
  fake.files.delete(`chats/${chatId}/${d.id}.source`);
  const unavailable=await resolveImageFollowup({message:'What do you think of it?',history:[message(saved.assets,saved.attachments)],catalog:[d],actorId,chatId,freshCount:0},{
    registerLegacy:(m,i)=>fake.service().registerLegacy(actorId,chatId,m,i),read:async f=>(await fake.factory().readGenerated(actorId,chatId,f.id)).descriptor});
  assert.equal(unavailable?.selections.length,0);assert.match(unavailable?.clarification??'',/cannot be reopened/);
});

test('URL retention refuses arbitrary destinations and validates provider response bytes without redirects or credentials',async()=>{
  let calls=0;
  const transport:typeof fetch=async(_input,init)=>{calls++;assert.equal(init?.redirect,'error');assert.equal(init?.headers,undefined);return new Response('expired',{status:404});};
  for(const url of ['http://imgen.x.ai/x','https://localhost/x','https://169.254.169.254/x','https://evil.example/x','https://user:pass@imgen.x.ai/x'])
    await assert.rejects(generatedImageBytes(url,transport),/safely reopened/);
  assert.equal(calls,0);
  await assert.rejects(generatedImageBytes('https://imgen.x.ai/expired?private=never-log',transport),error=>{
    assert.ok(error instanceof Error);assert.doesNotMatch(error.message,/private|https/);return true;
  });assert.equal(calls,1);
  await assert.rejects(generatedImageBytes('data:image/png;base64,not an image'),/Invalid/);
});

test('real chat persistence publishes canonical source-bound assets only after source retention succeeds',async()=>{
  const fake=storage(),url=await image(),route=readFileSync('app/api/chat/route.ts','utf8');
  const start=route.indexOf('            const assistantMessageId = pendingVideoAssistantMessageId ?? taskProgressAssistantMessageId;');
  const end=route.indexOf('            emitChunk({',start);
  assert.ok(start>0&&end>start);
  const code=ts.transpileModule(`(async()=>{${route.slice(start,end)} return imageAssets;})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const persisted:Message[]=[];
  const assets=await vm.runInNewContext(code,{
    pendingVideoAssistantMessageId:null,taskProgressAssistantMessageId:messageId,actorId,chatId,requestId:'generation-request',
    imageAssets:[{type:'image',url}],imageGenerationRequested:true,imageFollowup:null,savedAttachments:[],attachmentSourceIds:new Set(),
    cachedWorkflowValue:async(_key:string,run:()=>Promise<unknown>)=>run(),workflowTimestamp:()=>createdAt,
    generatedImageService:()=>fake.service(),readGeneratedImage:(...args:Parameters<ReturnType<typeof fake.factory>['readGenerated']>)=>fake.factory().readGenerated(...args),currentStandaloneWorkflow:()=>null,result:{provider:'google',model:'image-fixture'},
    assistantText:'[Image Generated]',assistantPresentation:null,
    saveMessage:async(_chat:string,value:Message)=>{assert.equal([...fake.files.keys()].filter(p=>p.endsWith('.source')).length,1);persisted.push(value);},
  });
  assert.equal(persisted.length,1);assert.equal(persisted[0].assets?.[0].url,url);
  assert.equal(persisted[0].attachments?.[0].id,assets[0].attachmentId);
  assert.equal(persisted[0].attachments?.[0].conversationUsage,'generated');
  const identity=generatedImageId({actorId,chatId,messageId,imageIndex:0});assert.equal(assets[0].attachmentId,identity);
});

test('the actual route preparation observes generated images with the durable workflow ID before chat receipt allocation',async()=>{
  const fake=storage(),saved=await generate(fake,{url:await image()}),d=saved.attachments[0];
  const reference=(await fake.factory().readGenerated(actorId,chatId,d.id)).reference;
  const route=readFileSync('app/api/chat/route.ts','utf8');
  const start=route.indexOf('    const freshTaskDescriptions =');
  const end=route.indexOf('    await observeImages(newAttachments);',start);
  assert.ok(start>0&&end>start);
  const js=ts.transpileModule(`(async()=>{${route.slice(start,end)}
    await observeImages([reference]);await observeImages([reference],true);
    return freshTaskDescriptions;
  })()`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  let calls=0;
  const execute=(operation:'inspect'|'edit')=>vm.runInNewContext(js,{
    getAccountingScope:()=>({kind:'standalone'}),currentAgentTask:()=>null,isStillImageCreationRequest:()=>false,
    imageFollowup:{operation},actorId,chatId,message:operation==='inspect'?'What do you think of it?':'Change her shirt.',
    verifiedWorkflow:{workflow:{request_id:'leased-workflow'}},Map,catalog:[d],reference,
    observeGeneratedImage:async(input:{requestId:string})=>{calls++;assert.equal(input.requestId,'leased-workflow');return{observation:{observationSourceHash:'verified'},descriptor:d};},
    observeStandaloneStillImages:async()=>{throw Error('Generated source cannot enter unclaimed image observation');},
  });
  assert.equal((await execute('inspect')).size,1);assert.equal(calls,1);
  assert.equal((await execute('edit')).size,0);assert.equal(calls,1,'edits retain raw pixels and do not pay for text observation');
});

test('new uncovered details trigger fresh inspection; policy refusals preserve the original and prior perception',async()=>{
  const fake=storage(),saved=await generate(fake,{url:await image()}),d=saved.attachments[0];
  const reference=(await fake.factory().readGenerated(actorId,chatId,d.id)).reference;
  let calls=0;
  const inspect=observer(fake,async()=>{calls++;return calls===3?"I'm sorry, but I cannot fulfill this request because of the content policy.":facts;});
  await inspect({actorId,chatId,requestId:'one',attachment:d,reference,question:'What do you think of it?'});
  const detailed=await inspect({actorId,chatId,requestId:'two',attachment:d,reference,question:'Describe the tiny label in the corner.'});
  assert.equal(calls,2,'generic scene memory must not stand in for uncovered detail');
  assert.equal(detailed.observation.observationQuestion,'Describe the tiny label in the corner.');
  const refusal=await inspect({actorId,chatId,requestId:'three',attachment:d,reference,question:'Look again at this image.'});
  assert.equal(calls,3);assert.equal(refusal.observation.observationAgreement,'policy-limited');
  assert.equal(refusal.observation.observedSummary,undefined);
  assert.ok(verifiedKatieVisualEpisode(refusal.descriptor),'a failed reinspection must not erase prior successful perception');
  assert.ok((await fake.factory().readGenerated(actorId,chatId,d.id)).source.size,'source remains retained');
  assert.match(imageObservationAsText(reference,refusal.observation).extractedText!,/unavailable|declined/i);
});

test('corrupt render identity and deleted pixels cannot become completed observation receipts',async()=>{
  const fake=storage(),saved=await generate(fake,{url:await image()}),d=saved.attachments[0];
  const path=`chats/${chatId}/${d.id}.json`;
  const original=fake.files.get(path)!;
  const metadata=JSON.parse(await original.text());metadata.reference.imageDataUrl=await image('red');
  fake.files.set(path,new Blob([JSON.stringify(metadata)]));
  await assert.rejects(fake.factory().readGenerated(actorId,chatId,d.id),/identity/);
  fake.files.set(path,original);
  await assert.rejects(fake.factory().withGeneratedObservation({actorId,chatId,id:d.id,requestId:'lost',key:'key'},async()=>{
    fake.files.delete(`chats/${chatId}/${d.id}.source`);return {text:'must not commit'};
  }),/unavailable/);
  assert.equal([...fake.files.keys()].filter(p=>p.endsWith('.result.json')).length,0);
});

test('image reply control sends exact message/index identity rather than a user-supplied URL',()=>{
  const panel=readFileSync('components/chat-panel.tsx','utf8');
  assert.match(panel,/assetIndex: replySnapshot.imageIndex/);
  assert.match(panel,/imageSource \? \{ imageSource \} : \{\}/);
  assert.match(panel,/Use this image in my next message/);
  assert.match(panel,/aria-pressed=\{replyTo\?\.id === message.id/);
});


test('actual route restoration revalidates generated original bytes even when source selection was checkpointed',async()=>{
  const fake=storage(),saved=await generate(fake,{url:await image()}),d=saved.attachments[0];
  const route=readFileSync('app/api/chat/route.ts','utf8');
  const start=route.indexOf('    const restored = await loadSelectedAttachmentSources(');
  const end=route.indexOf('    // Index the exact selected source',start);
  assert.ok(start>0&&end>start);
  const code=ts.transpileModule(`(async()=>{${route.slice(start,end)}return {restored,imageEditUnavailable};})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  let genericReads=0;
  const selection={method:'continuity',operation:'edit',selections:[{attachment:d,mode:'source'}]};
  const run=()=>vm.runInNewContext(code,{
    actorId,chatId,imageFollowup:selection,attachmentDecision:selection,
    getChatById:async()=>({actorId,id:chatId}),
    loadSelectedAttachmentSources,
    imageEditSourceUnavailable,
    readGeneratedImage:(...args:Parameters<ReturnType<typeof fake.factory>['readGenerated']>)=>fake.factory().readGenerated(...args),
    restoreConversationAttachment:async()=>{genericReads++;throw Error('Cannot trust generic cached renderer without the original');},
  });
  const intact=await run();
  assert.equal(intact.restored.references.length,1);
  assert.equal(intact.restored.references[0].fileId,d.id);
  assert.equal(intact.restored.sourceIds.has(d.id),true);
  assert.equal(intact.imageEditUnavailable,false);
  fake.files.delete(`chats/${chatId}/${d.id}.source`);
  const missing=await run();
  assert.equal(missing.restored.references.length,0);
  assert.equal(missing.restored.sourceIds.has(d.id),false);
  assert.equal(missing.restored.unavailable[0],d.fileName);
  assert.equal(missing.imageEditUnavailable,true);
  assert.equal(genericReads,0);
});

test('image advice stays inspection; unresolvable edit source blocks generation',async()=>{
  const fake=storage(),saved=await generate(fake,{url:await image()}),original=saved.attachments[0];
  const history=[message(saved.assets,saved.attachments)];
  assert.equal(imageFollowupIntent('What would you change about this image?'),'inspect');
  assert.equal(imageFollowupIntent('Describe how you would change the background'),'inspect');
  assert.equal(choose(history,[original],'What would you change about this image?')?.operation,'inspect');
  assert.equal(choose(history,[original],'Describe how you would change the background')?.operation,'inspect');
  assert.equal(imageFollowupIntent('Change the background'),'edit');
  assert.equal(imageFollowupIntent('Could you change her shirt to navy?'),'edit');
  const selection={method:'continuity' as const,operation:'edit' as const,
    selections:[{attachment:original,mode:'source' as const}]};
  assert.equal(imageEditSourceUnavailable(selection,new Set<string>()),true);
  assert.equal(imageEditSourceUnavailable(selection,new Set([original.id])),false);
  assert.equal(imageEditSourceUnavailable({...selection,operation:'inspect'},new Set<string>()),false);
});
