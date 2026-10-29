import { createHash } from 'node:crypto';
import { blockUnaccountedPaidDispatch } from '@/lib/standalone-accounting/unsupported';
import { getAccountingScope } from '@/lib/standalone-accounting/context';
import { canonicalJson } from '@/lib/standalone-accounting/estimate';
import { createStandaloneLedger, StandaloneAccountingError } from '@/lib/standalone-accounting/ledger';
import { QWEN_STILL_POLICY as policy } from '@/lib/standalone-accounting/runpod-policy';
import { parseRunpodOutput, requireRunpodKey } from '@/lib/runpod/durable-results';
import type { LedgerAttempt, ResponseCheckpoint } from '@/lib/standalone-accounting/types';

const JOB_ID = /^[A-Za-z0-9-]{8,150}$/;
const MAX_POLL_MS = 90_000;
const POLL_MS = 2500;
type Job = { id?: string; status?: string; output?: unknown; error?: unknown; delayTime?:number; executionTime?:number };
type Dependencies = {
  fetchFn?: typeof fetch;
  sleep?: (ms:number)=>Promise<void>;
  now?: ()=>number;
  ledgerFactory?: typeof createStandaloneLedger;
  attachmentId?: string;
  onStatus?: (stage:string)=>void;
};
export type StillObservation = {text:string;model:string;coverage:'full'|'sampled'|'metadata';jobId:string;sourceHash:string};
const failure=(code:string,message:string)=>new StandaloneAccountingError(code,message);
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

function observation(job:Job, sourceHash:string):StillObservation {
  const parsed=parseRunpodOutput(job as Record<string,unknown>);
  const first=Array.isArray(job.output)?job.output[0]:job.output;
  if(first&&typeof first==='object'&&'model' in first&&typeof first.model==='string'&&first.model!==policy.model)throw new Error('The approved Qwen endpoint returned a different model identity. Its output was not used as Qwen evidence.');
  const choice=first&&typeof first==='object'?(first as {choices?:Array<{finish_reason?:string}>}).choices?.[0]:undefined;
  if(job.status!=='COMPLETED'||parsed.status!=='completed'||!parsed.analysis_text)
    throw new Error('RunPod Qwen returned no usable still-image observation.');
  const text=parsed.analysis_text.slice(0,8000);
  const incomplete=choice?.finish_reason==='length'||/\b(?:coverage\s*:\s*(?:partial|incomplete)|unable to (?:read|see|identify)|cannot (?:read|see|determine)|illegible|insufficient (?:resolution|detail))\b/i.test(text);
  return {text,model:'runpod:'+policy.model,coverage:incomplete?'sampled':'full',jobId:job.id!,sourceHash};
}

/** One durable standalone infrastructure attempt. Submission is claimed once;
 * reconnects poll the same saved job, and complete outcomes replay without HTTP.
 * Non-standalone paths retain their previous unpriced-dispatch protection. */
export async function describeImageWithRunpodQwen(imageDataUrl:string,question:string,deps:Dependencies={}):Promise<StillObservation>{
  if(!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(imageDataUrl)||imageDataUrl.length>policy.maxImageCharacters)
    throw failure('unsupported_image','RunPod still-image analysis requires one bounded JPEG, PNG or WebP.');
  const scope=getAccountingScope();
  if(scope?.kind!=='standalone')blockUnaccountedPaidDispatch('RunPod still-image analysis');
  if(scope?.kind!=='standalone')throw failure('context_missing','Authenticated standalone accounting is required.');
  const context=scope.context;
  const apiKey=requireRunpodKey();
  const fetchFn=deps.fetchFn??fetch;
  const sleep=deps.sleep??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
  const now=deps.now??Date.now;
  const userPrompt=question.trim().slice(0,policy.maxQuestionCharacters)||'Describe the visible contents of this uploaded photograph factually.';
  const sourceHash=digest(imageDataUrl);
  const payload={policy:{executionTimeout:policy.executionTimeoutMs,ttl:policy.ttlMs},input:{
    route:'/v1/chat/completions',method:'POST',body:{model:policy.model,temperature:0,max_tokens:policy.maxOutputTokens,
      messages:[{role:'user',content:[{type:'image_url',image_url:{url:imageDataUrl}},{type:'text',text:userPrompt}]}]}
  }};
  const data={schemaVersion:'standalone-runpod-still-v1',provider:policy.provider,model:policy.model,endpoint:policy.endpoint,
    payload,attachmentId:deps.attachmentId??sourceHash,sourceHash,question:userPrompt};
  const prepared={...data,hash:digest(canonicalJson(data)),serializedBody:canonicalJson(payload)};
  // Content/question identity, not a fragile upstream helper ordinal. Distinct
  // images cannot inherit one another's job or approval on workflow replay.
  const attemptKey='qwen-still:'+sourceHash+':'+digest(userPrompt);
  const ledger=(deps.ledgerFactory??createStandaloneLedger)();
  if(!await ledger.authorizeScope(context.userId,context.actorId,context.chatId))throw failure('scope_denied','Standalone image spending authorization denied.');
  let attempt=await ledger.lookupAttempt(context.userId,context.requestId,attemptKey);
  const estimate={status:'estimated',requestHash:prepared.hash,pricingVersion:policy.version,estimatorVersion:policy.version,
    reservationMicrousd:policy.reservationMicrousd,estimatedCostMicrousd:policy.reservationMicrousd,currency:'USD',isCeiling:false,
    costKind:policy.costKind,inputTokens:0,imageTokens:0,outputAllowance:policy.maxOutputTokens,
    assumptions:['Fixed conservative infrastructure reservation; exact monetary cost is unknown until an authoritative receipt is available.'],issues:[]};
  if(attempt){
    if(attempt.actor_id!==context.actorId||attempt.chat_id!==context.chatId||attempt.prepared_hash!==prepared.hash||attempt.pricing_version!==policy.version||attempt.reserved_microusd!==policy.reservationMicrousd||canonicalJson(attempt.prepared_payload)!==canonicalJson(prepared))
      throw failure('replay_mismatch','Saved Qwen image preparation differs; the original job will not be resubmitted.');
    if(attempt.cancelled_by_owner_at||attempt.state==='cancelled')throw failure('cancelled','Remaining work was cancelled by its owner.');
  }else{
    await ledger.registerPricing(policy.version,policy);
    attempt=await ledger.admit({ownerId:context.userId,actorId:context.actorId,chatId:context.chatId,requestId:context.requestId,attemptKey,
      preparedHash:prepared.hash,preparedPayload:prepared,pricingVersion:policy.version,provider:policy.provider,model:policy.model,
      reservedMicrousd:policy.reservationMicrousd,category:'attachment-observation',preflightEstimate:estimate,estimatorVersion:policy.version,
      reason:'Bounded Qwen still-image observation; estimated infrastructure exposure'});
  }
  const annotate=(error:Error)=>Object.assign(error,{attemptId:attempt!.id});
  if(attempt.state==='paused')throw annotate(failure('approval_required','Qwen image analysis is paused for spending approval.'));
  const checkActive=async()=>{
    if(context.signal?.aborted)throw annotate(failure('runpod_in_progress','Qwen analysis was interrupted. Its existing job is retained; resume polls it without resubmitting.'));
    if(!await ledger.authorizeScope(context.userId,context.actorId,context.chatId))throw annotate(failure('scope_denied','Standalone image access was revoked.'));
    const current=await ledger.lookupAttempt(context.userId,context.requestId,attemptKey);
    if(!current||current.cancelled_by_owner_at||current.state==='cancelled')throw annotate(failure('cancelled','Remaining work was cancelled by its owner.'));
    return current;
  };
  const savedJob=(row:LedgerAttempt):Job|undefined=>{
    if(!row.response_checkpoint)return;
    const value=JSON.parse(row.response_checkpoint.body) as Job;
    if(value.id!==row.provider_request_id||!value.id||!JOB_ID.test(value.id))throw failure('runpod_job_mismatch','Saved Qwen job identity does not match its provider receipt.');
    return value;
  };
  if(attempt.response_checkpoint&&['estimated','settled'].includes(attempt.state)){
    deps.onStatus?.('Using saved Qwen observation');
    if(attempt.response_checkpoint.status!==200)throw new Error('RunPod rejected this saved image submission; it was not resent.');
    return observation(savedJob(attempt)!,sourceHash);
  }
  if(attempt.state==='uncertain'&&attempt.response_checkpoint&&await ledger.uncertainExposureAccepted(context.userId,attempt.id)){
    deps.onStatus?.('Using saved Qwen observation');
    if(attempt.response_checkpoint.status!==200)throw new Error('The acknowledged saved Qwen rejection cannot provide output; separate image escalation is required.');
    return observation(savedJob(attempt)!,sourceHash);
  }
  let job=savedJob(attempt);
  let jobId=attempt.provider_request_id;
  if(jobId&&!JOB_ID.test(jobId))throw annotate(failure('runpod_job_mismatch','Saved Qwen job identifier is invalid.'));
  if(!jobId){
    if(attempt.state==='uncertain'&&await ledger.uncertainExposureAccepted(context.userId,attempt.id))throw new Error('The owner accepted the unknown Qwen submission exposure. No Qwen output is available and this attempt will not be resent; separate image escalation is required.');
    if(attempt.state!=='reserved')throw annotate(failure('outcome_unknown','Qwen submission may already have been sent, but no job identity was saved. The reservation remains held; it will not be resubmitted.'));
    await checkActive();
    const claimed=await ledger.claimDispatch(context.userId,attempt.id);
    if(!claimed)throw annotate(failure('dispatch_conflict','Qwen image analysis cannot be submitted again. Refresh the saved job state.'));
    deps.onStatus?.('Analyzing image with Qwen…');
    try{
      const submitted=await fetchFn('https://api.runpod.ai'+policy.endpoint,{
        method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json',Accept:'application/json'},
        cache:'no-store',redirect:'error',signal:AbortSignal.timeout(25_000),body:prepared.serializedBody,
      });
      if(!submitted.ok){
        if([400,401,403,404,422,429].includes(submitted.status)){
          await submitted.body?.cancel();
          await ledger.completeQwenRejection(context.userId,attempt.id,{status:submitted.status,statusText:'Rejected',headers:[],body:canonicalJson({status:'REJECTED',httpStatus:submitted.status})});
          throw Object.assign(new Error('RunPod still-image submission was definitively rejected.'),{qwenRejected:true});
        }
        throw new Error('RunPod still-image submission failed (HTTP '+submitted.status+').');
      }
      job=await submitted.json() as Job;
      if(typeof job.id!=='string'||!JOB_ID.test(job.id))throw new Error('RunPod still-image submission returned no valid job identity.');
      jobId=job.id;
      // Persist acceptance before consulting the browser's cancellation signal.
      await ledger.recordProviderIdentifiers(context.userId,attempt.id,jobId,null);
    }catch(error){
      if(error&&typeof error==='object'&&'qwenRejected' in error)throw error;
      await ledger.markUncertain(context.userId,attempt.id,'Qwen submission outcome or job registration is unknown; fixed infrastructure exposure remains held.').catch(()=>{});
      if(await ledger.uncertainExposureAccepted(context.userId,attempt.id))throw new Error('Qwen outcome is unknown; the full reserved exposure is authorized and retained. This attempt will not be resent; separate image escalation is required.');
      throw annotate(failure('outcome_unknown','Qwen submission outcome is unknown. The full reservation is retained and this attempt will not be resubmitted.'));
    }
  }
  const deadline=now()+MAX_POLL_MS;
  try{
    while(!job||job.status==='IN_QUEUE'||job.status==='IN_PROGRESS'){
      await checkActive();
      if(now()+POLL_MS>=deadline)throw annotate(failure('runpod_in_progress','Qwen image analysis is still queued or running. Resume polls the saved job; it does not submit another job.'));
      deps.onStatus?.('Qwen image analysis queued…');
      await sleep(POLL_MS);
      const status=await fetchFn('https://api.runpod.ai/v2/'+policy.endpointId+'/status/'+jobId,{
        method:'GET',headers:{Authorization:'Bearer '+apiKey,Accept:'application/json'},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(18_000),
      });
      if(status.status===404)throw annotate(failure('runpod_result_unavailable','The saved Qwen result is expired or unavailable. Its exposure is retained and the job will not be resubmitted.'));
      if(!status.ok)throw annotate(failure('runpod_in_progress','Qwen status is temporarily unavailable. Resume polls the saved job without resubmitting.'));
      const next=await status.json() as Job;
      if(next.id!==jobId)throw annotate(failure('runpod_job_mismatch','RunPod still-image job identity changed.'));
      job=next;
    }
    if(!['COMPLETED','FAILED','CANCELLED','TIMED_OUT'].includes(job.status??''))throw annotate(failure('runpod_result_unavailable','RunPod returned an unsupported job state. Its exposure is retained and the job will not be resubmitted.'));
    // Save both successful and definitive failed job outcomes once. Worker timing
    // and output are evidence, not an exact bill; never multiply by a guessed rate.
    const checkpoint:ResponseCheckpoint={status:200,statusText:'OK',headers:[['content-type','application/json']],body:canonicalJson(job)};
    await ledger.completeQwenEstimate(context.userId,attempt.id,jobId!,checkpoint,{
      kind:'estimated_infrastructure',policyVersion:policy.version,jobId,sourceHash,endpoint:policy.endpoint,
      monetaryReceiptAvailable:false,executionTime:job.executionTime??null,delayTime:job.delayTime??null,
    });
    await checkActive();
    deps.onStatus?.('Qwen image analysis complete');
    return observation(job,sourceHash);
  }catch(error){
    // A known accepted job remains pollable on reconnect. Never turn a failed
    // poll into another POST or release its exposure.
    if(error instanceof StandaloneAccountingError)throw error;
    if(job&&['COMPLETED','FAILED','CANCELLED','TIMED_OUT'].includes(job.status??''))throw error;
    throw annotate(failure('runpod_in_progress','Qwen result retrieval was interrupted. Resume polls the original saved job without resubmitting.'));
  }
}
