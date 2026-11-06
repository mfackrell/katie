// Trusted Task 4A native host ONLY. The Codex child does not receive the
// GitHub Actions OPENAI_API_KEY or this binding key. No model inference here.
import {createHmac,timingSafeEqual} from 'node:crypto';

export const TASK4A_MODEL='gpt-5.3-codex';
export const TASK4A_MODEL_LOOKUP_URL='https://api.openai.com/v1/models/gpt-5.3-codex';
export const TASK4A_MODEL_ELIGIBILITY_VERSION='task4a-native-model-lookup-v1';
export const TASK4A_ELIGIBILITY_MAX_AGE_MS=15*60*1000;
const sha=/^[a-f0-9]{40}$/;
const digest=/^[a-f0-9]{64}$/;
const deny=()=>{throw Error('TASK4A_MODEL_ELIGIBILITY_UNVERIFIED')};

export function nativeCredentialBinding({apiKey,signingKey}){
 if(typeof apiKey!=='string'||apiKey.length<20||typeof signingKey!=='string'||signingKey.length<32)deny();
 // The existing Responses client forwards only Authorization. Do not assert an
 // organization/project header identity it did not actually send.
 return createHmac('sha256',signingKey)
  .update('katie:task4a:native-openai-key-default:v1\0','utf8')
  .update(apiKey,'utf8').digest('hex');
}

export async function retrieveNativeModelNonbillable({
 apiKey,signingKey,fetchImpl=fetch,now=Date.now()
}){
 const credentialBinding=nativeCredentialBinding({apiKey,signingKey});
 if(!Number.isSafeInteger(now)||now<0)deny();
 let result;
 try{
  result=await fetchImpl(TASK4A_MODEL_LOOKUP_URL,{
   method:'GET',redirect:'error',
   headers:{Authorization:'Bearer '+apiKey,Accept:'application/json'},
   signal:AbortSignal.timeout(10000)
  });
 }catch{deny()}
 if(result.status!==200||!String(result.headers?.get('content-type')??'').toLowerCase().includes('application/json'))deny();
 let parsed;
 try{
  const raw=await result.text();
  if(raw.length>4096)deny();
  parsed=JSON.parse(raw);
 }catch{deny()}
 if(!parsed||parsed.object!=='model'||parsed.id!==TASK4A_MODEL||
    typeof parsed.owned_by!=='string'||!parsed.owned_by||
    (parsed.shutdown_date!==null&&parsed.shutdown_date!==undefined&&
      (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.shutdown_date)||
       Date.parse(parsed.shutdown_date+'T23:59:59Z')<=now)))deny();
 // A 200 proves model visibility to this exact credential on this endpoint,
 // NOT Responses-create authorization. Keep that limitation explicit.
 return Object.freeze({
  version:TASK4A_MODEL_ELIGIBILITY_VERSION,
  source:'openai.models.retrieve',
  method:'GET',endpoint:TASK4A_MODEL_LOOKUP_URL,
  model:TASK4A_MODEL,responseObject:'model',httpStatus:200,
  credentialSource:'github-actions:OPENAI_API_KEY',
  organizationContext:'key-default',projectContext:'key-default',
  credentialBinding,observedAt:new Date(now).toISOString(),
  expiresAt:new Date(now+TASK4A_ELIGIBILITY_MAX_AGE_MS).toISOString(),
  proofLevel:'credential_scoped_model_visibility_not_responses_create'
 });
}

export function assertNativeModelEligibility({
 evidence,registry,releaseSha,apiKey,signingKey,now=Date.now()
}){
 const expected=nativeCredentialBinding({apiKey,signingKey});
 const observed=Date.parse(evidence?.observedAt??''),expires=Date.parse(evidence?.expiresAt??'');
 const capabilityAt=Date.parse(registry?.capability_verified_at??'');
 const priceAt=Date.parse(registry?.pricing_verified_at??'');
 if(!sha.test(releaseSha??'')||!digest.test(evidence?.credentialBinding??'')||
    !Number.isSafeInteger(now)||!Number.isFinite(observed)||!Number.isFinite(expires)||
    observed>now||observed<now-TASK4A_ELIGIBILITY_MAX_AGE_MS||
    expires<=now||expires>observed+TASK4A_ELIGIBILITY_MAX_AGE_MS||
    evidence?.version!==TASK4A_MODEL_ELIGIBILITY_VERSION||
    evidence?.source!=='openai.models.retrieve'||evidence?.method!=='GET'||
    evidence?.endpoint!==TASK4A_MODEL_LOOKUP_URL||
    evidence?.model!==TASK4A_MODEL||evidence?.responseObject!=='model'||
    evidence?.httpStatus!==200||
    evidence?.credentialSource!=='github-actions:OPENAI_API_KEY'||
    evidence?.organizationContext!=='key-default'||evidence?.projectContext!=='key-default'||
    evidence?.proofLevel!=='credential_scoped_model_visibility_not_responses_create'||
    evidence?.releaseSha!==releaseSha||
    !timingSafeEqual(Buffer.from(evidence.credentialBinding,'hex'),Buffer.from(expected,'hex'))||
    registry?.provider_name!=='openai'||registry?.model_id!==TASK4A_MODEL||
    registry?.is_active!==true||registry?.capability_status!=='verified'||
    registry?.routing_eligibility!=='verified'||
    !Number.isFinite(capabilityAt)||capabilityAt>now||
    capabilityAt<now-TASK4A_ELIGIBILITY_MAX_AGE_MS||
    registry?.pricing_status!=='verified'||
    !Number.isFinite(priceAt)||priceAt>now||priceAt<now-24*60*60*1000||
    Number(registry?.pricing_input_per_1m)!==1.75||
    Number(registry?.pricing_output_per_1m)!==14||
    registry?.source_metadata?.pricing_verification_source!==
     'https://developers.openai.com/api/docs/models/gpt-5.3-codex')deny();
 return true;
}
