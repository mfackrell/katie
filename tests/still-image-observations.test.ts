import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FileReference } from '@/lib/providers/types';
import type { ConversationAttachment } from '@/lib/chat/attachment-continuity';
import { observeStandaloneStillImages, retainNewImageObservations, imageObservationAsText, reusableImageObservation, imageObservationHash, isStillImageCreationRequest, requiresAdditionalImageDetail, requiresCrossImageInspection } from '@/lib/uploads/still-image-observations';

const image=(id='one',pixels='pixels'):FileReference=>({fileId:id,fileName:`${id}.png`,mimeType:'image/png',attachmentKind:'image',preview:'trusted image',imageDataUrl:`data:image/png;base64,${Buffer.from(pixels).toString('base64')}`});
const model='runpod:Qwen/Qwen3-VL-8B-Instruct';

test('ordinary screenshot observes with Qwen first then supplies only labelled text to conversation',async()=>{
  const ref=image(),calls:string[]=[],stages:string[]=[];
  const result=await observeStandaloneStillImages([ref],{question:'Write an opener for this profile',qwen:async(_pixels,_question,options)=>{
    calls.push('qwen');assert.equal(options?.attachmentId,'one');return {text:'Profile says gardener and homesteader. Beach in the background.',model,coverage:'full'};
  },escalate:async()=>{calls.push('premium');throw Error('Ordinary image must not call premium');},onStatus:s=>stages.push(s)});
  assert.deepEqual(calls,['qwen']);
  const evidence=imageObservationAsText(ref,result.get('one')!);
  assert.equal(evidence.mimeType,'text/plain');assert.equal(evidence.imageDataUrl,undefined);assert.equal(evidence.providerRef,undefined);
  assert.match(evidence.extractedText!,/gardener and homesteader/);assert.match(evidence.extractedText!,/not user-authored fact/);assert.match(evidence.extractedText!,/Coverage: full/);
  assert.deepEqual(stages,['Analyzing image with Qwen…','Qwen image analysis complete']);
});

test('same trusted immutable observation is reused on another turn with zero submissions',async()=>{
  const ref=image();let calls=0;
  const first=(await observeStandaloneStillImages([ref],{question:'Describe this profile',qwen:async()=>({text:'Gardener with a beach photograph.',model,coverage:'full'})})).get(ref.fileId)!;
  const saved:ConversationAttachment={...first,id:'stored-id',fileName:ref.fileName,mimeType:ref.mimeType};
  const stages:string[]=[];
  const second=await observeStandaloneStillImages([{...ref,fileId:'new-turn'}],{question:'Give me a playful opener',saved:[saved],qwen:async()=>{calls++;throw Error('Must reuse');},escalate:async()=>{calls++;throw Error('Must reuse');},onStatus:s=>stages.push(s)});
  assert.equal(calls,0);assert.equal(second.get('new-turn')!.observedSummary,first.observedSummary);assert.deepEqual(stages,['Using saved Qwen observation']);
  assert.equal(reusableImageObservation(image('different','changed pixels'),[saved],'Describe this profile'),undefined);
  assert.equal(first.observationSourceHash,imageObservationHash(ref.imageDataUrl!));
});

test('bounded multiple images retain independent identities and do not silently drop extras',async()=>{
  const refs=[image('left','left'),image('right','right')],seen:string[]=[];
  const result=await observeStandaloneStillImages(refs,{question:'Summarize each profile',qwen:async(_pixels,_question,options)=>{
    seen.push(options!.attachmentId!);return {text:`Observed ${options!.attachmentId}`,model,coverage:'full'};
  },escalate:async()=>{throw Error('Independent summaries need no cross-image raw call');}});
  assert.deepEqual(seen,['left','right']);assert.equal(result.size,2);assert.equal(result.get('left')!.observedSummary,'Observed left');assert.equal(result.get('right')!.observedSummary,'Observed right');
  await assert.rejects(observeStandaloneStillImages(Array.from({length:6},(_,i)=>image(String(i)))),{code:'standalone_unsupported_image'});
});

test('incomplete Qwen evidence escalates once for the entire image set and can be reused for that question',async()=>{
  const refs=[image('a','a'),image('b','b')];let qwen=0,premium=0;
  const question='Compare these screenshots for subtle visual differences';
  const options={question,qwen:async()=>{qwen++;return {text:'Small labels are illegible.',model,coverage:'sampled' as const};},escalate:async(images:string[],prompt:string)=>{
    premium++;assert.equal(images.length,2);assert.match(prompt,/Image 1: a.png/);assert.match(prompt,/Image 2: b.png/);return {text:'Image 1 has a blue label; Image 2 has a green label.',model:'supported-vision'};
  }};
  const result=await observeStandaloneStillImages(refs,options);
  assert.equal(qwen,2);assert.equal(premium,1);
  const saved=refs.map(ref=>({...result.get(ref.fileId)!,id:ref.fileId,fileName:ref.fileName,mimeType:ref.mimeType}));
  await observeStandaloneStillImages(refs,{...options,saved,qwen:async()=>{throw Error('No repeated Qwen');},escalate:async()=>{throw Error('No repeated escalation');}});
  assert.equal(premium,1);
});

test('early discovery and final source selection share observations and one bounded escalation',async()=>{
  const ref=image();let qwen=0,premium=0;
  const options={question:'Read the small print',qwen:async()=>{qwen++;return {text:'Small print is illegible.',model,coverage:'sampled' as const};},escalate:async()=>{premium++;return {text:'The small print says valid through Friday.',model:'supported-vision'};}};
  const initial=await observeStandaloneStillImages([ref],{...options,deferEscalation:true});
  assert.equal(premium,0);
  await observeStandaloneStillImages([ref],{...options,initial});
  assert.equal(qwen,1);assert.equal(premium,1);
});

test('completed partial evidence is retained before escalation failure and resumes with the same descriptor',async()=>{
  const ref=image();let saves=0;
  const checkpointValues=new Map<string,unknown>();
  const checkpoint=async<T>(key:string,load:()=>Promise<T>):Promise<T>=>{
    if(checkpointValues.has(key))return checkpointValues.get(key) as T;
    const value=await load();checkpointValues.set(key,value);return value;
  };
  const initial=await observeStandaloneStillImages([ref],{deferEscalation:true,qwen:async()=>({text:'The heading is visible; the small print is illegible.',model,coverage:'sampled'})});
  const save=async(reference:FileReference,description:ReturnType<typeof initial.get>):Promise<ConversationAttachment>=>{
    saves++;return {...description,id:'one-retained-descriptor',fileName:reference.fileName,mimeType:reference.mimeType,hasOriginal:true};
  };
  const retained=await retainNewImageObservations([ref],initial,save,checkpoint);
  await assert.rejects(observeStandaloneStillImages([ref],{initial,escalate:async()=>{throw Error('No priceable escalation');}}),/No priceable escalation/);
  assert.match(retained.get(ref.fileId)!.observedSummary!,/heading is visible/);
  const resumed=await retainNewImageObservations([ref],initial,save,checkpoint);
  assert.equal(saves,1);assert.equal(resumed.get(ref.fileId)!.id,retained.get(ref.fileId)!.id);
  const route=readFileSync('app/api/chat/route.ts','utf8');
  assert.ok(route.indexOf('await retainNewImageObservations(newAttachments')<route.indexOf('await observeImages(requestAttachments,true)'));
  assert.match(route,/retainedImageDescriptors.get\(attachment.fileId\) \?\? await persistConversationAttachment/g);
});

test('unavailable or unsupported escalation stops with a terminal technical limitation rather than provider loop',async()=>{
  let premium=0;
  await assert.rejects(observeStandaloneStillImages([image()],{qwen:async()=>{throw Error('Qwen provider failed');},escalate:async()=>{premium++;throw Object.assign(new Error('No supported image billing'),{code:'standalone_no_priceable_vision',terminal:true});}}),{code:'standalone_no_priceable_vision',terminal:true});
  assert.equal(premium,1);
  assert.throws(()=>imageObservationAsText(image(),{observedSummary:'Unavailable',summaryCoverage:'metadata'}),{code:'standalone_no_priceable_vision'});
});

test('capability gates retain technical escalation while image generation and video remain separate',()=>{
  assert.equal(requiresAdditionalImageDetail('Interpret this medical x-ray'),true);assert.equal(requiresAdditionalImageDetail('Check the dosage in this label'),true);
  assert.equal(requiresCrossImageInspection('Compare these photos for subtle visual differences',2),true);
  assert.equal(requiresCrossImageInspection('Write an opener for each profile',2),false);
  assert.equal(isStillImageCreationRequest('Edit this photo to remove the background'),true);assert.equal(isStillImageCreationRequest('Write an opener for this profile photo'),false);
  const route=readFileSync('app/api/chat/route.ts','utf8');
  assert.match(route,/getAccountingScope\(\)\?\.kind === 'standalone' && !currentAgentTask\(\)/);
  assert.match(route,/imageObservationAsText\(file,freshTaskDescriptions.get\(file.fileId\)!\)/);
  assert.match(route,/deferEscalation:!final/);
});

test('real escalation selector excludes unpriceable image models before preparation and compares qualified image payload costs',async t=>{
  const providers=await import('../lib/providers');
  const {escalateStillImageEvidence}=await import('../lib/uploads/still-image-observations');
  const {captureControlPlanePreparation}=await import('../lib/router/control-plane-economics');
  const {prepareStandaloneRequest}=await import('../lib/standalone-accounting/estimate');
  const {runWithStandaloneAccounting}=await import('../lib/standalone-accounting/context');
  const {PRICING_SNAPSHOT}=await import('../lib/standalone-accounting/pricing');
  const old=globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__;
  t.after(()=>{globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__=old;});
  const prepared:string[]=[],sent:string[]=[];
  globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__={async rpc(name:string){
    if(name==='standalone_request_uncertainties')return{data:[],error:null};
    if(name==='standalone_load_pricing')return{data:{snapshot:PRICING_SNAPSHOT,retrievedAt:new Date().toISOString()},error:null};
    if(name==='standalone_lookup_attempt')return{data:null,error:null};
    assert.fail('No unsupported image attempt may be created: '+name);
  }} as unknown as NonNullable<typeof globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__>;
  t.mock.method(providers,'getAvailableProviders',()=>[
    {name:'grok',listModels:async()=>['grok-4.7'],generate:async()=>{assert.fail('Grok image billing is unsupported and must be excluded before preparation');}},
    {name:'openai',listModels:async()=>['gpt-4o','gpt-4o-mini'],generate:async(params:import('../lib/providers/types').ChatGenerateParams)=>{
      const model=params.modelId!;prepared.push(model);
      captureControlPlanePreparation(prepareStandaloneRequest('openai',model,'/v1/chat/completions',{model,max_tokens:1400,messages:[{role:'user',content:[{type:'text',text:params.user},...params.images!.map(url=>({type:'image_url',image_url:{url}}))]}]}));
      sent.push(model);return {provider:'openai',model,text:'Readable image evidence from the selected supported model.'};
    }},
  ]);
  const pixels=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(pixels);pixels.writeUInt32BE(100,16);pixels.writeUInt32BE(100,20);
  const result=await runWithStandaloneAccounting({userId:'owner',actorId:'actor',chatId:'chat',requestId:'priceable-image'},()=>escalateStillImageEvidence(['data:image/png;base64,'+pixels.toString('base64')],'Describe visible contents'));
  assert.ok(prepared.includes('gpt-4o')&&prepared.includes('gpt-4o-mini'));
  assert.deepEqual(sent,['gpt-4o-mini']);assert.equal(result.model,'gpt-4o-mini');
});

test('owner can request additional ordinary inspection of an aspect absent from the saved observation without forcing premium',async()=>{
 const ref=image();
 const first=(await observeStandaloneStillImages([ref],{question:'Describe the profile',qwen:async()=>({text:'The profile mentions gardening and a beach.',model,coverage:'full'})})).get(ref.fileId)!;
 const saved:ConversationAttachment={...first,id:'stored-id',fileName:ref.fileName,mimeType:ref.mimeType};
 let reinspections=0;
 const result=await observeStandaloneStillImages([ref],{saved:[saved],question:'Inspect the bottom half again; what color are the shoes? The saved observation does not cover this.',qwen:async()=>{reinspections++;return {text:'The shoes are blue.',model,coverage:'full'};},escalate:async()=>{assert.fail('Ordinary requested reinspection does not itself require premium');}});
 assert.equal(reinspections,1);assert.equal(result.get(ref.fileId)!.observedSummary,'The shoes are blue.');
});

test('paid escalation admission fence checks durable Qwen uncertainty before pricing, ranking or dispatch',async t=>{
 const {escalateStillImageEvidence}=await import('../lib/uploads/still-image-observations');
 const {runWithStandaloneAccounting}=await import('../lib/standalone-accounting/context');
 const previous=globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__;t.after(()=>{globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__=previous;});
 const calls:string[]=[];let accepted=false;
 globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__={async rpc(name:string){calls.push(name);
   if(name==='standalone_request_uncertainties')return{data:[{id:'qwen',request_id:'incident',provider:'runpod',model:'Qwen/Qwen3-VL-8B-Instruct',state:'uncertain'}],error:null};
   if(name==='standalone_uncertain_exposure_accepted')return{data:accepted,error:null};
   if(name==='standalone_load_pricing'&&accepted)throw Error('Authorized next safe checkpoint reached');
   assert.fail('No pricing, provider selection or paid dispatch before owner authorization: '+name);
 }} as unknown as NonNullable<typeof globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__>;
 await assert.rejects(runWithStandaloneAccounting({userId:'owner',actorId:'actor',chatId:'chat',requestId:'incident'},()=>escalateStillImageEvidence([image().imageDataUrl!],'describe')),{code:'standalone_outcome_unknown'});
 assert.deepEqual(calls,['standalone_request_uncertainties','standalone_uncertain_exposure_accepted']);
 accepted=true;
 await assert.rejects(runWithStandaloneAccounting({userId:'owner',actorId:'actor',chatId:'chat',requestId:'incident'},()=>escalateStillImageEvidence([image().imageDataUrl!],'describe')),error=>error instanceof Error && error.cause instanceof Error && /Authorized next safe checkpoint reached/.test(error.cause.message));
 assert.equal(calls.at(-1),'standalone_load_pricing');
});


test('refusal-only premium fallback is rejected instead of stored as sampled visual evidence',async()=>{
  const ref=image('refused');let calls=0;
  await assert.rejects(observeStandaloneStillImages([ref],{
    qwen:async()=>({text:'Small text is illegible.',model,coverage:'sampled'}),
    escalate:async()=>{calls++;return{text:"I'm sorry, but I can't assist with that.",model:'gpt-4o-mini'};}
  }),{code:'standalone_no_priceable_vision'});
  assert.equal(calls,1,'refusal cannot trigger an unbounded provider loop');
});

test('limited but factual premium observations are retained rather than discarded as refusals',async()=>{
  const ref=image('partial');
  const description='I cannot provide exact measurements from this image. The diagram shows a blue rectangle labeled 10 cm by 5 cm.';
  const observations=await observeStandaloneStillImages([ref],{
    qwen:async()=>({text:'Fine dimensions are illegible.',model,coverage:'sampled'}),
    escalate:async()=>({text:description,model:'gpt-4o-mini'})
  });
  assert.match(observations.get('partial')?.observedSummary??'',/blue rectangle labeled 10 cm by 5 cm/);
  assert.equal(observations.get('partial')?.summaryCoverage,'sampled');
});
