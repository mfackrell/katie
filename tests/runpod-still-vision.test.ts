import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { observeStandaloneStillImages } from '../lib/uploads/still-image-observations';
import { describeImageWithRunpodQwen } from '../lib/chat/runpod-still-vision';
import { runWithStandaloneAccounting } from '../lib/standalone-accounting/context';
import { createStandaloneLedger } from '../lib/standalone-accounting/ledger';
import { QWEN_STILL_POLICY } from '../lib/standalone-accounting/runpod-policy';
import type { LedgerAttempt } from '../lib/standalone-accounting/types';

const scope={userId:'owner',actorId:'actor',chatId:'chat',requestId:'original-request'};
const image='data:image/jpeg;base64,QUJDRA==';
const key=process.env.RUNPOD_API_KEY;
afterEach(()=>{if(key===undefined)delete process.env.RUNPOD_API_KEY;else process.env.RUNPOD_API_KEY=key;});
function fixture(){
  process.env.RUNPOD_API_KEY='fixture-key';
  let row:LedgerAttempt|null=null, sends=0, polls=0, now=0, allowed=true, pause=false, failPoll=false, mismatch=false, queue=false, submissionStatus=200, lostAcceptance=false, exposureAccepted=false;
  const calls:Array<{name:string;args:Record<string,unknown>}>=[];
  const ledger=createStandaloneLedger({async rpc<T>(name:string,args:Record<string,unknown>){
    calls.push({name,args});let result:unknown;
    if(name==='standalone_uncertain_exposure_accepted')result=exposureAccepted;
    else if(name==='standalone_authorize_scope')result=allowed;
    else if(name==='standalone_register_pricing')result=true;
    else if(name==='standalone_lookup_attempt')result=row;
    else if(name==='standalone_admit'){
      row={id:'attempt',owner_id:args.p_owner,actor_id:args.p_actor,chat_id:args.p_chat,request_id:args.p_request,attempt_key:args.p_key,prepared_hash:args.p_hash,prepared_payload:args.p_payload,pricing_version:args.p_pricing,provider:args.p_provider,model:args.p_model,reserved_microusd:args.p_reserved,category:args.p_category,state:pause?'paused':'reserved',actual_microusd:null,provider_request_id:null,provider_receipt_id:null,response_checkpoint:null,cancelled_by_owner_at:null} as LedgerAttempt;result=row;
    }else if(name==='standalone_claim_dispatch'){
      result=row?.state==='reserved'?row:null;if(result)row={...row!,state:'dispatched'};
    }else if(name==='standalone_record_provider_identifiers'){
      row={...row!,provider_request_id:String(args.p_request_id)};result=row;
    }else if(name==='standalone_mark_uncertain'){
      row={...row!,state:'uncertain'};result=row;
    }else if(name==='standalone_complete_qwen_rejection'){
      row={...row!,state:'estimated',response_checkpoint:args.p_checkpoint as LedgerAttempt['response_checkpoint']};result=row;
    }else if(name==='standalone_complete_qwen_estimate'){
      assert.equal(args.p_job,row?.provider_request_id);row={...row!,state:'estimated',response_checkpoint:args.p_checkpoint as LedgerAttempt['response_checkpoint'],evidence:args.p_evidence as Record<string,unknown>};result=row;
    }else assert.fail('Unexpected ledger action '+name);
    return {data:result as T,error:null};
  }});
  const wire:typeof fetch=async(input,init)=>{
    if(String(input).endsWith('/run')){
      sends++;assert.equal(init?.method,'POST');
      const body=JSON.parse(String(init?.body));
      assert.equal(body.input.body.messages[0].content[0].image_url.url,image);
      assert.equal(body.input.body.model,QWEN_STILL_POLICY.model);
      assert.equal(body.policy.executionTimeout,60000);assert.equal(body.input.body.max_tokens,1400);
      assert.equal(String(init?.body),(row?.prepared_payload as {serializedBody:string}).serializedBody);
      assert.equal(row?.state,'dispatched','durable claim precedes transmission');
      if(lostAcceptance)throw Error('Connection lost after POST');
      if(submissionStatus!==200)return new Response('Rejected',{status:submissionStatus});
      return Response.json({id:'job-accepted-123',status:'IN_QUEUE'});
    }
    polls++;assert.match(String(input),/\/status\/job-accepted-123$/);
    if(failPoll)throw Error('Disconnected');
    if(queue)return Response.json({id:'job-accepted-123',status:'IN_PROGRESS'});
    return Response.json({id:mismatch?'another-job-456':'job-accepted-123',status:'COMPLETED',executionTime:1200,output:{choices:[{finish_reason:'stop',message:{content:'A brown dog in a room.'}}],usage:{prompt_tokens:100,completion_tokens:10},cost:0}});
  };
  const run=()=>runWithStandaloneAccounting(scope,()=>describeImageWithRunpodQwen(image,'Describe photo',{ledgerFactory:()=>ledger,fetchFn:wire,sleep:async()=>{now+=2500;},now:()=>now,attachmentId:'immutable-attachment'}));
  return {run,calls,ledger,get row(){return row;},get sends(){return sends;},get polls(){return polls;},set failPoll(v:boolean){failPoll=v;},set queue(v:boolean){queue=v;},set allowed(v:boolean){allowed=v;},set pause(v:boolean){pause=v;},set mismatch(v:boolean){mismatch=v;},set submissionStatus(v:number){submissionStatus=v;},set lostAcceptance(v:boolean){lostAcceptance=v;},set exposureAccepted(v:boolean){exposureAccepted=v;},set state(v:LedgerAttempt['state']){row={...row!,state:v};}};
}
test('Qwen reserves reviewed $0.02 under original owner/request before one submission and retains estimate without inventing actual',async()=>{
  const f=fixture(),result=await f.run();
  assert.equal(result.text,'A brown dog in a room.');assert.equal(result.coverage,'full');assert.match(result.model,/runpod:Qwen/);
  assert.equal(f.sends,1);assert.equal(f.polls,1);assert.equal(f.row?.state,'estimated');assert.equal(f.row?.reserved_microusd,'20000');assert.equal(f.row?.actual_microusd,null);assert.equal(f.row?.provider_receipt_id,null);
  const input=f.calls.find(c=>c.name==='standalone_admit')!.args;
  assert.equal(input.p_request,scope.requestId);assert.equal(input.p_owner,scope.userId);assert.equal(input.p_actor,scope.actorId);assert.equal(input.p_chat,scope.chatId);assert.equal(input.p_pricing,QWEN_STILL_POLICY.version);
  assert.equal((input.p_estimate as {costKind:string}).costKind,'estimated_infrastructure');assert.ok(20000<500000);
  assert.equal(f.calls.filter(c=>c.name==='standalone_settle').length,0,'worker-supplied cost:0 is not authoritative monetary evidence');
});
test('reconnect/restart replays the same complete outcome with zero new HTTP and retained exposure',async()=>{
  const f=fixture();await f.run();const calls=f.polls;await f.run();assert.equal(f.sends,1);assert.equal(f.polls,calls);assert.equal(f.row?.reserved_microusd,'20000');
});
test('poll transport timeout retains accepted identity; resume only polls original job',async()=>{
  const f=fixture();f.failPoll=true;await assert.rejects(f.run(),{code:'standalone_runpod_in_progress'});assert.equal(f.row?.provider_request_id,'job-accepted-123');assert.equal(f.sends,1);
  f.failPoll=false;await f.run();assert.equal(f.sends,1);assert.equal(f.polls,2);assert.equal(f.row?.state,'estimated');
});
test('bounded polling expiry can resume original job without another POST',async()=>{
  const f=fixture();f.queue=true;await assert.rejects(f.run(),{code:'standalone_runpod_in_progress'});assert.equal(f.sends,1);assert.ok(f.polls<40);
  f.queue=false;await f.run();assert.equal(f.sends,1);assert.equal(f.row?.state,'estimated');
});
test('threshold pause sends no RunPod traffic',async()=>{const f=fixture();f.pause=true;await assert.rejects(f.run(),{code:'standalone_approval_required'});assert.equal(f.sends,0);assert.equal(f.polls,0);});
test('revoked scope prevents both submission and saved-result access',async()=>{const f=fixture();await f.run();f.allowed=false;await assert.rejects(f.run(),{code:'standalone_scope_denied'});assert.equal(f.sends,1);});
test('returned job mismatch is terminal and never results in a replacement submission',async()=>{const f=fixture();f.mismatch=true;await assert.rejects(f.run(),{code:'standalone_runpod_job_mismatch'});await assert.rejects(f.run(),{code:'standalone_runpod_job_mismatch'});assert.equal(f.sends,1);});
test('RunPod refuses invalid pixels before ledger or paid traffic',async()=>{let calls=0;await assert.rejects(describeImageWithRunpodQwen('data:text/plain;base64,SGk=','describe',{fetchFn:async()=>{calls++;throw Error('Unexpected');}}),/requires one bounded/);assert.equal(calls,0);});

test('non-paid runtime release probe reports the same reviewed Qwen policy without a submission',async()=>{
 const {GET}=await import('../app/api/version/route');
 process.env.RUNPOD_API_KEY='fixture-private-key';
 const response=await GET(),body=await response.json();
 assert.equal(body.standaloneStillImages.defaultProvider,'runpod');
 assert.equal(body.standaloneStillImages.model,QWEN_STILL_POLICY.model);
 assert.equal(body.standaloneStillImages.reservationMicrousd,'20000');
 assert.equal(body.standaloneStillImages.configured,true);
 assert.ok(!JSON.stringify(body).includes('fixture-private-key'));
});


test('definitive submission rejection retains estimated exposure and is replayed without resubmission',async()=>{
 const f=fixture();f.submissionStatus=429;await assert.rejects(f.run(),/definitively rejected/);
 assert.equal(f.row?.state,'estimated');assert.equal(f.row?.provider_request_id,null);assert.equal(f.row?.reserved_microusd,'20000');assert.equal(f.row?.actual_microusd,null);
 await assert.rejects(f.run(),/not resent/);assert.equal(f.sends,1);assert.equal(f.polls,0);
});
test('lost submission acceptance without a job identity remains uncertain and never submits again',async()=>{
 const f=fixture();f.lostAcceptance=true;await assert.rejects(f.run(),{code:'standalone_outcome_unknown'});
 assert.equal(f.row?.state,'uncertain');assert.equal(f.row?.provider_request_id,null);
 await assert.rejects(f.run(),{code:'standalone_outcome_unknown'});assert.equal(f.sends,1);assert.equal(f.row?.reserved_microusd,'20000');
});

test('explicit owner acceptance of lost Qwen exposure permits independent fallback without inventing output or another Qwen POST',async()=>{
 const f=fixture();f.lostAcceptance=true;await assert.rejects(f.run(),{code:'standalone_outcome_unknown'});
 f.exposureAccepted=true;await assert.rejects(f.run(),error=>error instanceof Error&&!('terminal' in error)&&/separate image escalation/.test(error.message));
 assert.equal(f.sends,1);assert.equal(f.row?.state,'uncertain');assert.equal(f.row?.reserved_microusd,'20000');assert.equal(f.row?.actual_microusd,null);
});

test('accepted uncertain saved Qwen output replays without clearing uncertainty or pretending to settle a conflict',async()=>{
 const f=fixture();await f.run();f.state='uncertain';f.exposureAccepted=true;
 const completions=f.calls.filter(c=>c.name==='standalone_complete_qwen_estimate').length;
 const result=await f.run();assert.equal(result.text,'A brown dog in a room.');
 assert.equal(f.row?.state,'uncertain');assert.equal(f.row?.reserved_microusd,'20000');assert.equal(f.row?.actual_microusd,null);assert.equal(f.sends,1);
 assert.equal(f.calls.filter(c=>c.name==='standalone_complete_qwen_estimate').length,completions);
});

test('genuine attached image stops before every paid escalation until owner accepts; resumes without retransmitting Qwen',async()=>{
 const f=fixture();f.lostAcceptance=true;let premium=0;
 const reference={fileId:'image',fileName:'current.jpg',mimeType:'image/jpeg',attachmentKind:'image' as const,preview:'',imageDataUrl:image};
 const run=()=>observeStandaloneStillImages([reference],{qwen:()=>f.run(),escalate:async()=>{premium++;return{text:'Visible grounded evidence',model:'premium'};}});
 await assert.rejects(run(),{code:'standalone_outcome_unknown'});
 assert.equal(premium,0);assert.equal(f.row?.state,'uncertain');assert.equal(f.row?.provider_request_id,null);
 await assert.rejects(run(),{code:'standalone_outcome_unknown'});assert.equal(premium,0);assert.equal(f.sends,1);
 f.exposureAccepted=true;await run();assert.equal(premium,1);assert.equal(f.sends,1);assert.equal(f.row?.reserved_microusd,'20000');assert.equal(f.row?.state,'uncertain');
});

test('incident 14774c56: failed image then plain text never reuses hidden JPEG or invokes vision',async()=>{
 const {cleanPendingAttachments}=await import('../lib/ui/pending-attachments');
 const {inferRequestIntentFromMultimodalInput}=await import('../lib/router/model-intent');
 const f=fixture();f.lostAcceptance=true;await assert.rejects(f.run(),{code:'standalone_outcome_unknown'});
 const composer=cleanPendingAttachments({images:[],imageFiles:[],videos:[],files:[],references:[{fileId:'old-failed-image',fileName:'old.jpg',mimeType:'image/jpeg',attachmentKind:'image',preview:'',imageDataUrl:image}]});
 const message='Katie, that is an awesome start but i know you can do way better';
 let qwen=0,premium=0;
 await observeStandaloneStillImages(composer.references,{question:message,qwen:async()=>{qwen++;throw Error('Unexpected Qwen');},escalate:async()=>{premium++;throw Error('Unexpected paid escalation');}});
 assert.equal(await inferRequestIntentFromMultimodalInput(message,composer.images),null);
 assert.deepEqual(composer.references,[]);assert.equal(qwen,0);assert.equal(premium,0);assert.equal(f.sends,1);
});

test('Qwen uncertainty auto-authorized by durable owner policy escalates without a prompt or duplicate submission',async()=>{
 const f=fixture();f.lostAcceptance=true;f.exposureAccepted=true;let escalations=0;
 const ref={fileId:'genuine',fileName:'current.jpg',mimeType:'image/jpeg',attachmentKind:'image' as const,preview:'',imageDataUrl:image};
 for(let i=0;i<2;i++)await observeStandaloneStillImages([ref],{qwen:()=>f.run(),escalate:async()=>{escalations++;return{text:'Safe independent observation',model:'premium'};}});
 assert.equal(f.sends,1);assert.equal(escalations,2);assert.equal(f.row?.state,'uncertain');assert.equal(f.row?.reserved_microusd,'20000');
});
