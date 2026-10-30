import { createHash } from 'node:crypto';
import { getAccountingScope } from '@/lib/standalone-accounting/context';
import { createStandaloneLedger, StandaloneAccountingError } from '@/lib/standalone-accounting/ledger';
import { canonicalJson } from '@/lib/standalone-accounting/estimate';
import { VENICE_STILL_POLICY as policy } from '@/lib/standalone-accounting/venice-policy';
import type { ResponseCheckpoint } from '@/lib/standalone-accounting/types';

const VENICE_HOST='https://api.venice.ai';
const IMAGE=/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
type Dependencies = {
  fetchFn?:typeof fetch;
  ledgerFactory?:typeof createStandaloneLedger;
  key?:string;
  attachmentId?:string;
  onStatus?:(stage:string)=>void;
};
export class VeniceUnavailable extends Error {
  constructor(message:string){super(message);this.name='VeniceUnavailable';}
}
export type VeniceStillObservation={text:string;model:string;coverage:'full'|'sampled'};
type VeniceCompletion={
  id?:unknown;model?:unknown;
  choices?:Array<{finish_reason?:unknown;message?:{content?:unknown}}>;
  usage?:{prompt_tokens?:unknown;completion_tokens?:unknown};
};
/** Only the pinned model, vision capability and <= reviewed pricing qualify.
 * The catalog is free; a missing/unverifiable price never authorizes inference.
 * No image or user message is sent during discovery.
 */
export async function verifyVeniceVisionCatalog(key:string,transport:typeof fetch=fetch):Promise<void>{
  let response:Response;
  try{response=await transport(VENICE_HOST+'/api/v1/models',{
    method:'GET',headers:{Authorization:'Bearer '+key,Accept:'application/json'},
    cache:'no-store',redirect:'error',signal:AbortSignal.timeout(12000),
  });}catch{throw new VeniceUnavailable('Venice model discovery is unavailable.');}
  if(!response.ok){await response.body?.cancel();throw new VeniceUnavailable('Venice model discovery was rejected.');}
  let data:unknown;
  try{const raw=await response.text();if(raw.length>2_000_000)throw Error('Catalog too large');data=JSON.parse(raw);}
  catch{throw new VeniceUnavailable('Venice model catalog is invalid.');}
  const catalog=data&&typeof data==='object'?'data' in data?(data as {data?:unknown}).data:undefined:undefined;
  const models=Array.isArray(catalog)?catalog:[];
  const selected=models.find((item:unknown)=>item&&typeof item==='object'&&(item as {id?:unknown}).id===policy.model) as
    {model_spec?:{capabilities?:{supportsVision?:unknown};pricing?:{input?:{usd?:unknown};output?:{usd?:unknown}};privacy?:unknown;offline?:unknown}}|undefined;
  const spec=selected?.model_spec;
  const input=spec?.pricing?.input?.usd,output=spec?.pricing?.output?.usd;
  if(!spec||spec.capabilities?.supportsVision!==true||spec.offline===true||
    spec.privacy!=='private'||typeof input!=='number'||typeof output!=='number'||
    !Number.isFinite(input)||!Number.isFinite(output)||input<0||output<0||
    input>policy.inputUsdPerMillion||output>policy.outputUsdPerMillion)
    throw new VeniceUnavailable('The reviewed Venice vision model or its price is unavailable; no paid request was sent.');
}
function decoded(checkpoint:ResponseCheckpoint):VeniceStillObservation|null {
  if(checkpoint.status!==200)return null;
  let body:VeniceCompletion;
  try{body=JSON.parse(checkpoint.body) as VeniceCompletion;}catch{return null;}
  if(body.model!==policy.model||!Array.isArray(body.choices)||body.choices.length!==1)return null;
  const choice=body.choices[0];
  const text=choice?.message?.content;
  if(typeof text!=='string'||!text.trim())return null;
  if(choice.finish_reason!=='stop'&&choice.finish_reason!=='length')return null;
  return {text:text.trim().slice(0,policy.maxDescriptionCharacters),model:'venice:'+policy.model,coverage:choice.finish_reason==='length'?'sampled':'full'};
}
function responseCheckpoint(status:number,body:string):ResponseCheckpoint{
  return {status,statusText:status===200?'OK':'Definitive Venice rejection',headers:[['content-type','application/json']],body};
}
/** A single independently accounted, synchronous image-inspection attempt.
 * No retry on accepted/uncertain dispatch; an immutable saved result is replayed.
 * Never send image bytes to discovery, logs, or a different model.
 */
export async function describeImageWithVenice(image:string,question:string,deps:Dependencies={}):Promise<VeniceStillObservation|null>{
  if(!IMAGE.test(image)||image.length>policy.maxImageCharacters)
    throw new VeniceUnavailable('Venice image format exceeds the reviewed single-image bounds.');
  if(question.length<1||question.length>policy.maxPromptCharacters)
    throw new VeniceUnavailable('The Venice image prompt exceeds the reviewed bound.');
  const scope=getAccountingScope();
  if(scope?.kind!=='standalone')throw new StandaloneAccountingError('context_missing','Authenticated standalone accounting is required for Venice.');
  const key=deps.key??process.env.VENICE_API_KEY;
  if(!key?.trim())throw new VeniceUnavailable('VENICE_API_KEY has not been securely configured.');
  const ledger=(deps.ledgerFactory??createStandaloneLedger)();
  const context=scope.context,fetchFn=deps.fetchFn??fetch;
  const sourceHash=digest(image);
  const payload={
    model:policy.model,temperature:0,max_tokens:policy.maxOutputTokens,
    stream:false,store:false,
    venice_parameters:{enable_web_search:'off',enable_web_scraping:false,include_venice_system_prompt:false},
    messages:[{role:'user',content:[{type:'text',text:question},{type:'image_url',image_url:{url:image}}]}],
  };
  const data={schemaVersion:'standalone-venice-still-v1',provider:policy.provider,model:policy.model,
    endpoint:policy.endpoint,payload,attachmentId:deps.attachmentId??sourceHash,sourceHash,question};
  const prepared={...data,hash:digest(canonicalJson(data)),serializedBody:canonicalJson(payload)};
  const attemptKey='venice-still:'+sourceHash+':'+digest(question);
  if(!await ledger.authorizeScope(context.userId,context.actorId,context.chatId))
    throw new StandaloneAccountingError('scope_denied','Venice image inspection access denied.');
  let attempt=await ledger.lookupAttempt(context.userId,context.requestId,attemptKey);
  if(attempt){
    if(attempt.actor_id!==context.actorId||attempt.chat_id!==context.chatId||
      attempt.prepared_hash!==prepared.hash||attempt.pricing_version!==policy.version||
      attempt.reserved_microusd!==policy.reservationMicrousd||
      canonicalJson(attempt.prepared_payload)!==canonicalJson(prepared))
      throw new StandaloneAccountingError('replay_mismatch','The saved Venice request differs; it was not resent.');
    if(attempt.cancelled_by_owner_at||attempt.state==='cancelled')
      throw new StandaloneAccountingError('cancelled','Venice inference was cancelled.');
    if(attempt.response_checkpoint&&attempt.state==='estimated'){
      deps.onStatus?.('Using saved Dolphin Venice observation');
      return decoded(attempt.response_checkpoint);
    }
    if(attempt.state==='uncertain'&&await ledger.uncertainExposureAccepted(context.userId,attempt.id)){
      // Authorized continuation consumes no additional Venice inference.
      // The original reservation stays held and existing premium escalation
      // may proceed independently under the same original request budget.
      return null;
    }
    if(attempt.state==='uncertain'||attempt.state==='dispatched'||attempt.state==='settled')
      throw Object.assign(new StandaloneAccountingError('outcome_unknown','The prior Venice request outcome is unresolved; no duplicate image analysis was submitted.'),{attemptId:attempt.id});
    if(attempt.state==='paused')
      throw Object.assign(new StandaloneAccountingError('approval_required','Venice image analysis requires existing owner spending approval.'),{attemptId:attempt.id});
  }
  // Only first dispatch performs model/price discovery. Do not change a saved
  // prepared request or submit twice when the external result is uncertain.
  await verifyVeniceVisionCatalog(key,fetchFn);
  if(!attempt){
    await ledger.registerPricing(policy.version,policy);
    const estimate={status:'estimated',requestHash:prepared.hash,pricingVersion:policy.version,
      estimatorVersion:policy.version,reservationMicrousd:policy.reservationMicrousd,
      estimatedCostMicrousd:policy.reservationMicrousd,currency:'USD',isCeiling:false,
      costKind:'conservative_vision_reservation',inputTokens:0,imageTokens:0,
      outputAllowance:policy.maxOutputTokens,
      assumptions:['Full reviewed $0.10 exposure retained; exact Venice billing is unknown without a monetary receipt.'],
      issues:[]};
    attempt=await ledger.admit({ownerId:context.userId,actorId:context.actorId,chatId:context.chatId,
      requestId:context.requestId,attemptKey,preparedHash:prepared.hash,preparedPayload:prepared,
      pricingVersion:policy.version,provider:policy.provider,model:policy.model,
      reservedMicrousd:policy.reservationMicrousd,category:'attachment-observation',
      preflightEstimate:estimate,estimatorVersion:policy.version,
      reason:'One priced, bounded Dolphin Venice image-analysis fallback'});
  }
  if(attempt.state==='paused')
    throw Object.assign(new StandaloneAccountingError('approval_required','Venice fallback is paused for owner spending approval.'),{attemptId:attempt.id});
  if(attempt.state!=='reserved')
    throw Object.assign(new StandaloneAccountingError('outcome_unknown','Venice dispatch is not in an authorized state.'),{attemptId:attempt.id});
  const claimed=await ledger.claimDispatch(context.userId,attempt.id);
  if(!claimed)throw Object.assign(new StandaloneAccountingError('approval_required','Venice spending admission was blocked; no inference was sent.'),{attemptId:attempt.id});
  deps.onStatus?.('Analyzing image with Dolphin Venice…');
  try{
    if(context.signal?.aborted)throw Error('Cancelled after claim');
    const response=await fetchFn(VENICE_HOST+policy.endpoint,{method:'POST',
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',Accept:'application/json'},
      body:prepared.serializedBody,cache:'no-store',redirect:'error',
      signal:AbortSignal.any([AbortSignal.timeout(policy.timeoutMs),...(context.signal?[context.signal]:[])])});
    if([400,401,402,403,404,422,429].includes(response.status)){
      await response.body?.cancel();
      const checkpoint=responseCheckpoint(response.status,JSON.stringify({status:response.status}));
      await ledger.completeVeniceEstimate(context.userId,attempt.id,checkpoint,{status:'rejected',sourceHash});
      throw new VeniceUnavailable('Venice declined this request, possibly due to unavailable credits or account access.');
    }
    if(!response.ok)throw Error('Venice inference outcome was not definitive');
    const bodyText=await response.text();
    if(bodyText.length>policy.maxResponseCharacters)throw Error('Venice returned an oversized response');
    const checkpoint=responseCheckpoint(200,bodyText);
    // Save the one real provider outcome before interpreting its contents.
    await ledger.completeVeniceEstimate(context.userId,attempt.id,checkpoint,{status:'completed',sourceHash});
    const result=decoded(checkpoint);
    deps.onStatus?.('Dolphin Venice image analysis complete');
    return result;
  }catch(error){
    if(error instanceof VeniceUnavailable)throw error;
    // The HTTP call may have been billed even if its outcome was lost. Retain
    // the entire reservation and require normal owner uncertainty handling.
    await ledger.markUncertain(context.userId,attempt.id,
      'Venice submission or result outcome is uncertain; the full exposure is retained.').catch(()=>{});
    throw Object.assign(new StandaloneAccountingError('outcome_unknown','Venice submission outcome is unknown. The attempt will not be resent.'),{attemptId:attempt.id});
  }
}
