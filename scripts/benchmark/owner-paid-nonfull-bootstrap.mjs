// Owner-gated, staging-only paid trial admission. Every submitted credential and
// dollar ceiling is checked before creating NEW replicate-2 accounts. Does not
// relabel the earlier synthetic token receipts as billable usage.
import {createClient} from '@supabase/supabase-js';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {frozenProtocol,protocolDigest,verifyCustomLedger} from './owner-staging-bootstrap.mjs';
import {assertBenchmarkDollarCeiling} from './paid-dollar-ceiling.mjs';
const STAGE='https://iytvavgbaainnsrecmcx.supabase.co';
const REPO='mfackrell/katie';
const MODEL='gpt-5.3-codex';
const CAP=350000;
const RATE=28000000;
const BASELINE='0015bcdb8ac9ad94b7c74d1a4cd76737903b1319';
const issueTitle='[benchmark-715] Owner-approved paid three-arm execution';
const id=/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const deny=reason=>{throw Error('BENCHMARK_PAID_OWNER_DENIED:'+reason)};
export function verifyPaidOwner(env,event){
 if(env.GITHUB_EVENT_NAME!=='issues'||event?.action!=='opened'||
    event?.issue?.title!==issueTitle||
    event?.issue?.user?.login?.toLowerCase()!==env.GITHUB_REPOSITORY_OWNER?.toLowerCase()||
    env.GITHUB_ACTOR?.toLowerCase()!==env.GITHUB_REPOSITORY_OWNER?.toLowerCase()||
    env.GITHUB_REPOSITORY!==REPO||event?.repository?.full_name!==REPO)
  deny('owner-event');
 if(env.KATIE_BENCHMARK_PAID_EXECUTION!=='enabled'||
    env.KATIE_NONFULL_STAGING_ONLY!=='verified'||
    env.KATIE_NONFULL_STAGING_SUPABASE_URL!==STAGE||
    env.KATIE_NONFULL_PRODUCTION_SUPABASE_URL===STAGE||
    !env.KATIE_NONFULL_PRODUCTION_SUPABASE_URL?.startsWith('https://')||
    !env.KATIE_NONFULL_STAGING_SERVICE_ROLE_KEY||
    !id.test(env.KATIE_NONFULL_STAGING_OWNER_ID??'')||
    typeof env.OPENAI_API_KEY!=='string'||env.OPENAI_API_KEY.length<20)
  deny('staging-or-provider-identity');
 return env.KATIE_NONFULL_STAGING_OWNER_ID;
}
const unique=(data)=>{if(!Array.isArray(data)||data.length!==1)deny('expected-one');return data[0]};
async function load(db,table){const {data,error}=await db.from(table).select('*');if(error)deny('read:'+table);return data}
async function add(db,table,row){
 const {data,error}=await db.from(table).insert(row).select('*').single();
 if(error||!data)deny('insert:'+table+':'+(error?.code||'failed'));
 return data;
}
export async function preparePaidTrial({db,ownerId}){
 const ledger=await load(db,'schema_migrations');
 verifyCustomLedger(ledger);
 const source=await load(db,'benchmark_three_arm_trials');
 const old=source.filter(x=>x.replicate===1);
 if(old.length!==3||source.some(x=>x.replicate!==1))deny('replicate-already-created');
 const sourceByArm=new Map(old.map(t=>[t.arm,t]));
 if(['native','thin','full'].some(arm=>!sourceByArm.has(arm)))deny('source-treatment-missing');
 const original=sourceByArm.get('native');
 if(original.baseline_sha!==BASELINE||sourceByArm.get('full').state!=='planned'||
  ['native','thin'].some(arm=>sourceByArm.get(arm).state!=='running'))deny('prior-qualification-not-complete');
 const refKeys=['experiment_id','baseline_sha','contract_sha256','acceptance_sha256','model_policy_sha256','tool_profile_sha256','runtime_sha256','owner_actor_id'];
 if(old.some(t=>refKeys.some(k=>t[k]!==original[k])))deny('unequal-source-protocol');
 const previous=await load(db,'benchmark_budget_accounts');
 if(previous.length!==3||
  previous.some(a=>a.experiment_id!==original.experiment_id||
   Number(a.cap_tokens)!==CAP||Number(a.spent_tokens)!==(a.arm==='full'?0:20)||a.frozen_at||
   a.trial_id!==sourceByArm.get(a.arm)?.id))deny('source-ledger-not-qualified');
 const syntheticCalls=await load(db,'benchmark_budget_calls');
 if(syntheticCalls.length!==8||syntheticCalls.some(c=>
  c.state!=='settled'||c.provider_namespace!=='nonbillable-synthetic-fixture'||
  Number(c.actual_tokens)!==5))deny('synthetic-receipts-unverified');
 const previousApprovals=await load(db,'benchmark_native_spending_approvals');
 if(previousApprovals.length!==2||previousApprovals.some(a=>
  a.owner_id!==ownerId||!a.consumed_at||a.revoked_at||
  !['native','thin'].some(arm=>a.trial_id===sourceByArm.get(arm).id)))deny('trusted-owner-history');
 const actor=original.owner_actor_id;
 const chats=await load(db,'chats');
 if(chats.length!==1||chats[0].actor_id!==actor)deny('staging-chat-boundary');
 const {data:price,error}=await db.from('model_registry')
  .select('pricing_status,pricing_input_per_1m,pricing_output_per_1m')
  .eq('provider_name','openai').eq('model_id',MODEL).maybeSingle();
 if(error||price?.pricing_status!=='verified')deny('model-price-not-verified');
 assertBenchmarkDollarCeiling({armUsdCents:1000,priceCeilingMicrosPerMillion:RATE,
  publishedInputUsdPerMillion:price.pricing_input_per_1m,
  publishedOutputUsdPerMillion:price.pricing_output_per_1m,
  accountTokens:CAP,approvalTokens:CAP});
 const results=[];
 const deadline=new Date(Date.now()+65*60*1000).toISOString();
 for(const arm of ['native','thin','full']){
  const prior=sourceByArm.get(arm);
  const trial=await add(db,'benchmark_three_arm_trials',{
   experiment_id:prior.experiment_id,replicate:2,arm,owner_actor_id:actor,
   baseline_sha:prior.baseline_sha,contract_sha256:prior.contract_sha256,
   acceptance_sha256:prior.acceptance_sha256,model_policy_sha256:prior.model_policy_sha256,
   tool_profile_sha256:prior.tool_profile_sha256,runtime_sha256:prior.runtime_sha256,
   state:arm==='full'?'planned':'qualified'});
  const account=await add(db,'benchmark_budget_accounts',{
   experiment_id:prior.experiment_id,trial_id:trial.id,arm,owner_actor_id:actor,
   cap_tokens:CAP,spent_tokens:0});
  let approval=null;
  if(arm!=='full')approval=await add(db,'benchmark_native_spending_approvals',{
    owner_id:ownerId,actor_id:actor,chat_id:chats[0].id,trial_id:trial.id,
    account_id:account.id,repository:REPO,model:MODEL,
    protocol_digest:protocolDigest(trial,CAP),max_tokens:CAP,deadline});
  results.push({arm,trialId:trial.id,accountId:account.id,
   approvalId:approval?.id??null,tokenCap:CAP,state:trial.state});
 }
 return {experimentId:original.experiment_id,replicate:2,model:MODEL,baselineSha:BASELINE,
  issue:715,scope:'non-production',ownerBound:true,allowedPaidUsdCents:3000,
  maxPerArmUsdCents:1000,conservativeMicrosPerMillion:RATE,expiresAt:deadline,
  arms:results};
}
if(process.argv[1]?.endsWith('owner-paid-nonfull-bootstrap.mjs')){
 if(!process.argv[2])deny('output-path-missing');
 const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
 const ownerId=verifyPaidOwner(process.env,event);
 const db=createClient(STAGE,process.env.KATIE_NONFULL_STAGING_SERVICE_ROLE_KEY,
  {auth:{persistSession:false,autoRefreshToken:false}});
 const outcome=await preparePaidTrial({db,ownerId});
 writeFileSync(process.argv[2],JSON.stringify(outcome,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('BENCHMARK_PAID_REPLICATE2_OWNER_GRANTED_NATIVE_THIN; FULL_PLANNED');
}
