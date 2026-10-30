import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithStandaloneAccounting } from '../lib/standalone-accounting/context';
import { describeImageWithVenice, verifyVeniceVisionCatalog, VeniceUnavailable } from '../lib/chat/venice-still-vision';
import { VENICE_STILL_POLICY as policy } from '../lib/standalone-accounting/venice-policy';
import { observeStandaloneStillImages, weakFocalPointDescription } from '../lib/uploads/still-image-observations';
import type { LedgerAttempt, ResponseCheckpoint } from '../lib/standalone-accounting/types';

const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAQAAAAAYLlVAAAAD0lEQVR42u3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAAB4G4aAAAFLdxv68AAAAASUVORK5CYII=';
const key='fixture-not-a-real-key';
const scope={userId:'owner',actorId:'actor',chatId:'chat',requestId:'original-venice-test'};
const catalog=(overrides:Record<string,unknown>={})=>({
  data:[{id:policy.model,model_spec:{privacy:'private',offline:false,
    capabilities:{supportsVision:true},pricing:{input:{usd:0.20},output:{usd:0.90}},...overrides}}],
});
const good='Primary focal point: A small blue ceramic cup occupies the center. '+
  'Detailed focal-point observations: The glossy cobalt glaze is uneven along the curved rim. '+
  'The near-facing handle is smooth and rounded with a sharp highlight, while the cup has a circular base. '+
  'Spatial relationships and interactions: The cup stands upright on a matte wooden table, with the handle on the right. '+
  'Secondary context: A plain pale wall is behind it, softly lit. Uncertainties: The volume of the cup cannot be measured from the image.';
function fixture(){
  let attempt:LedgerAttempt|null=null,sends=0,discovery=0,uncertain=0,dispatches=0;
  let mode:'success'|'denied'|'lost'|'malformed'='success';
  let modelSpec:Record<string,unknown>={};
  const ledger={
    authorizeScope:async()=>true,
    lookupAttempt:async()=>attempt,
    registerPricing:async()=>true,
    admit:async (entry:Record<string,unknown>)=>{
      attempt={id:'attempt-venice-1',owner_id:scope.userId,actor_id:scope.actorId,
        chat_id:scope.chatId,request_id:scope.requestId,attempt_key:entry.attemptKey as string,
        prepared_hash:entry.preparedHash as string,prepared_payload:entry.preparedPayload as Record<string,unknown>,
        pricing_version:entry.pricingVersion as string,provider:'venice',model:policy.model,
        reserved_microusd:entry.reservedMicrousd as string,state:'reserved',
        cancelled_by_owner_at:null,response_checkpoint:null} as LedgerAttempt;
      return attempt;
    },
    claimDispatch:async()=>{dispatches++;if(attempt?.state!=='reserved')return null;attempt={...attempt,state:'dispatched'};return attempt;},
    completeVeniceEstimate:async(_owner:string,_id:string,checkpoint:ResponseCheckpoint)=>{
      attempt={...attempt!,state:'estimated',response_checkpoint:checkpoint};return attempt;
    },
    markUncertain:async()=>{uncertain++;attempt={...attempt!,state:'uncertain'};return attempt;},
  };
  const transport:typeof fetch=async(url,init)=>{
    if(String(url).endsWith('/models')){
      discovery++;assert.equal(init?.method,'GET');
      assert.equal(init?.body,undefined,'catalog must never receive source images');
      return Response.json(catalog(modelSpec));
    }
    sends++;assert.equal(init?.method,'POST');
    assert.equal(String(url),'https://api.venice.ai/api/v1/chat/completions');
    const payload=JSON.parse(String(init?.body));
    assert.equal(payload.model,policy.model);
    assert.equal(payload.max_tokens,4096);
    assert.equal(payload.stream,false);
    assert.equal(payload.store,false);
    assert.equal(payload.venice_parameters.enable_web_search,'off');
    assert.equal(payload.messages[0].content[1].image_url.url,image);
    assert.equal(String(init?.body),(attempt?.prepared_payload as {serializedBody:string}).serializedBody);
    if(mode==='lost')throw Error('Lost transport after dispatch');
    if(mode==='denied')return Response.json({error:'No credits'}, {status:402});
    if(mode==='malformed')return Response.json({model:'swapped',choices:[{finish_reason:'stop',message:{content:'ignored'}}]});
    return Response.json({id:'chatcmpl-synthetic',model:policy.model,choices:[{finish_reason:'stop',message:{content:good}}],usage:{prompt_tokens:400,completion_tokens:180}});
  };
  const run=(question='Describe the image')=>runWithStandaloneAccounting(scope,()=>describeImageWithVenice(image,question,{key,ledgerFactory:()=>ledger as never,fetchFn:transport}));
  return {run,set mode(v:typeof mode){mode=v;},set modelSpec(v:Record<string,unknown>){modelSpec=v;},
    get sends(){return sends;},get discovery(){return discovery;},get uncertain(){return uncertain;},
    get dispatches(){return dispatches;},get attempt(){return attempt;}};
}
test('free catalog validation checks verified private vision capability and published price before paid traffic',async()=>{
  const f=fixture();f.modelSpec={privacy:'anonymized'};
  await assert.rejects(f.run(),VeniceUnavailable);assert.equal(f.sends,0);assert.equal(f.dispatches,0);
  await assert.rejects(verifyVeniceVisionCatalog(key,async()=>Response.json(catalog({pricing:{input:{usd:5},output:{usd:9}}}))),VeniceUnavailable);
  assert.equal(f.sends,0);
});
test('one accounted Venice POST replays immutable successful description with zero additional charges',async()=>{
  const f=fixture();const one=await f.run();
  assert.equal(one?.text,good);assert.equal(one?.model,'venice:'+policy.model);
  assert.equal(f.sends,1);assert.equal(f.dispatches,1);
  assert.equal(f.attempt?.state,'estimated');assert.equal(f.attempt?.reserved_microusd,'100000');
  assert.equal(f.attempt?.actual_microusd,undefined,'no monetary receipt is fabricated');
  const second=await f.run();
  assert.deepEqual(second,one);assert.equal(f.sends,1);
});
test('definitive insufficient-credit 402 completes once and is replayed without another POST',async()=>{
  const f=fixture();f.mode='denied';
  await assert.rejects(f.run(),VeniceUnavailable);
  const twice=await f.run();assert.equal(twice,null);
  assert.equal(f.sends,1);assert.equal(f.attempt?.state,'estimated');assert.equal(f.uncertain,0);
});
test('lost provider result remains uncertain and cannot create a duplicate inference',async()=>{
  const f=fixture();f.mode='lost';
  await assert.rejects(f.run(),{code:'standalone_outcome_unknown'});
  await assert.rejects(f.run(),{code:'standalone_outcome_unknown'});
  assert.equal(f.sends,1);assert.equal(f.uncertain,1);
});
test('unexpected model substitution is retained as evidence but never supplied to conversation',async()=>{
  const f=fixture();f.mode='malformed';
  const result=await f.run();assert.equal(result,null);assert.equal(f.attempt?.state,'estimated');
  assert.equal(f.sends,1);
});
test('without a configured key Venice cannot authorize a paid request',async()=>{
  const previous=process.env.VENICE_API_KEY;delete process.env.VENICE_API_KEY;
  try{await assert.rejects(runWithStandaloneAccounting(scope,()=>describeImageWithVenice(image,'describe')),VeniceUnavailable);}
  finally{if(previous===undefined)delete process.env.VENICE_API_KEY;else process.env.VENICE_API_KEY=previous;}
});
test('focal quality gate detects sparse Qwen descriptions but not detailed focal observations',()=>{
  assert.equal(weakFocalPointDescription('An object on a table.'),true);
  assert.equal(weakFocalPointDescription(good),false);
});
test('limited Qwen observation uses independent Dolphin once; premium route is not called',async()=>{
  const reference={fileId:'image-one',fileName:'photo.png',mimeType:'image/png',attachmentKind:'image' as const,preview:'',imageDataUrl:image};
  let qwen=0,venice=0,premium=0;
  const runner=()=>observeStandaloneStillImages([reference],{
    question:'Describe the main subject',
    qwen:async()=>{qwen++;return{text:'A cup on a table.',model:'runpod:Qwen/Qwen3-VL-8B-Instruct',coverage:'full' as const};},
    venice:async(pixels,prompt)=>{venice++;assert.equal(pixels,image);assert.match(prompt,/Primary focal point/);return{text:good,model:'venice:'+policy.model,coverage:'full' as const};},
    escalate:async()=>{premium++;throw Error('Unneeded premium escalation');},
  });
  const result=await runner();
  assert.equal(qwen,1);assert.equal(venice,1);assert.equal(premium,0);
  assert.equal(result.get('image-one')?.summaryModel,'venice:'+policy.model);
});
test('sufficient Qwen evidence never invokes Dolphin',async()=>{
  const reference={fileId:'image-one',fileName:'photo.png',mimeType:'image/png',attachmentKind:'image' as const,preview:'',imageDataUrl:image};
  let venice=0;
  const result=await observeStandaloneStillImages([reference],{
    qwen:async()=>({text:good,model:'runpod:Qwen/Qwen3-VL-8B-Instruct',coverage:'full' as const}),
    venice:async()=>{venice++;throw Error('Good Qwen observation must not be retried');},
  });
  assert.equal(venice,0);assert.match(result.get('image-one')?.summaryModel??'',/Qwen/);
});
test('Dolphin is delayed until after the existing Qwen checkpoint on resume',async()=>{
  const reference={fileId:'image-one',fileName:'photo.png',mimeType:'image/png',attachmentKind:'image' as const,preview:'',imageDataUrl:image};
  let qwen=0,venice=0;
  const first=await observeStandaloneStillImages([reference],{deferEscalation:true,
    qwen:async()=>{qwen++;return{text:'Too short.',model:'runpod:Qwen/Qwen3-VL-8B-Instruct',coverage:'full' as const};},
    venice:async()=>{venice++;return{text:good,model:'venice:'+policy.model,coverage:'full' as const};}});
  assert.equal(qwen,1);assert.equal(venice,0);
  const second=await observeStandaloneStillImages([reference],{initial:first,
    qwen:async()=>{qwen++;throw Error('Must not resubmit Qwen');},
    venice:async()=>{venice++;return{text:good,model:'venice:'+policy.model,coverage:'full' as const};}});
  assert.equal(qwen,1);assert.equal(venice,1);assert.equal(second.get('image-one')?.summaryModel,'venice:'+policy.model);
});
