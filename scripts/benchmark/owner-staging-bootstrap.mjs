// Owner-authenticated GitHub Actions only. Provisions isolated staging trial
// identity and NONBILLABLE Native/Thin admission records. Never starts inference,
// grants Full authority, or creates an executable paid Native/Thin adapter.
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {assertBenchmarkDollarCeiling} from './paid-dollar-ceiling.mjs';
const require=createRequire(resolve('package.json'));
const {createClient}=require('@supabase/supabase-js');
const REPO='mfackrell/katie';
const STAGING_REF='iytvavgbaainnsrecmcx';
const BASELINE='0015bcdb8ac9ad94b7c74d1a4cd76737903b1319';
const ARMS=['native','thin','full'];
const MODEL='gpt-5.3-codex';
const TOKENS=350000;
const PRICE_CEILING=28000000;
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
function deny(message){throw Error('BENCHMARK_OWNER_BOOTSTRAP_DENIED:'+message)}
export function frozenProtocol(){
 const manifest=JSON.parse(readFileSync(new URL('../../config/benchmark-715-readiness.json',import.meta.url),'utf8'));
 if(manifest.issue!==715||manifest.contractIssue!==650||manifest.repository!==REPO||
    manifest.model!==MODEL||manifest.baselineSha!==BASELINE||manifest.totalUsdCeilingCents!==3000||
    manifest.productionPublicationAllowed!==false||manifest.paidExecutionEnabled!==false||
    manifest.arms?.length!==3||
    ARMS.some(arm=>manifest.arms.filter(x=>x.arm===arm&&x.usdCeilingCents===1000).length!==1))
   deny('frozen-manifest');
 const contract={
   sourceIssue:650,baselineSha:BASELINE,
   initialStones:11,firstPlayer:'A',legalMoves:[1,2,3],lastMoveWins:true,
   invalidActionPreservesState:true,persistentReload:true,resetPersists:true,
   directory:'app/project-pilots/take-eleven/',
   tests:'tests/game-development/take-eleven.test.mjs',
   productionPublication:false
 };
 const acceptance=['initial-state','legal-moves','alternating-turns','invalid-unchanged',
  'a-wins','b-wins','reload-in-progress','reload-finished','reset-and-reload',
  'accessible-controls','private-preview','independent-review'];
 const modelPolicy={provider:'openai',model:MODEL,priceCeilingMicrosPerMillion:PRICE_CEILING,
  perArmUsdCents:1000,noWebSearch:true,noPremiumTools:true};
 const toolProfile={sdk:'@openai/codex-sdk@0.164.0',repository:REPO,
  protectedHost:true,isolatedWorkspace:true,sameEngineeringToolsAllArms:true};
 const runtime={node:'22',host:'shared-native-gateway',browser:'private-preview',
  noProductionDeployment:true};
 return {baselineSha:BASELINE,contract_sha256:sha(contract),acceptance_sha256:sha(acceptance),
  model_policy_sha256:sha(modelPolicy),tool_profile_sha256:sha(toolProfile),
  runtime_sha256:sha(runtime),contract,acceptance};
}
export function protocolDigest(trial,capTokens){
 return sha({experimentId:trial.experiment_id,replicate:trial.replicate,
  baselineSha:trial.baseline_sha,contractSha256:trial.contract_sha256,
  acceptanceSha256:trial.acceptance_sha256,toolProfileSha256:trial.tool_profile_sha256,
  modelPolicySha256:trial.model_policy_sha256,runtimeSha256:trial.runtime_sha256,
  tokenCap:capTokens});
}
export function verifyOwnerEnvironment(env,event){
 if(env.GITHUB_REPOSITORY!==REPO||!env.GITHUB_ACTOR||
    env.GITHUB_ACTOR.toLowerCase()!==env.GITHUB_REPOSITORY_OWNER?.toLowerCase())
   deny('github-owner');
 if(event?.repository?.full_name!==REPO)deny('repository-event');
 if(env.GITHUB_EVENT_NAME==='issues'){
  if(event.action!=='opened'||event.issue?.user?.login?.toLowerCase()!==
    env.GITHUB_REPOSITORY_OWNER?.toLowerCase()||
    event.issue?.title!=='[benchmark-715] Owner staging nonbillable qualification')
    deny('owner-issue');
 }else if(env.GITHUB_EVENT_NAME!=='workflow_dispatch')deny('trigger');
 if(env.KATIE_NONFULL_STAGING_ONLY!=='verified'||env.KATIE_BENCHMARK_PAID_EXECUTION!=='disabled'||
    env.OPENAI_API_KEY||env.CODEX_ACCESS_TOKEN)deny('nonbillable-only');
 if(env.KATIE_NONFULL_STAGING_SUPABASE_URL!==`https://${STAGING_REF}.supabase.co`||
    env.KATIE_NONFULL_STAGING_SUPABASE_URL===env.KATIE_NONFULL_PRODUCTION_SUPABASE_URL||
    !env.KATIE_NONFULL_PRODUCTION_SUPABASE_URL?.startsWith('https://')||
    !env.KATIE_NONFULL_STAGING_SERVICE_ROLE_KEY||!uuid.test(env.KATIE_NONFULL_STAGING_OWNER_ID||''))
    deny('staging-identity');
 return env.KATIE_NONFULL_STAGING_OWNER_ID;
}
// Compare EVERY committed migration checksum against the authoritative custom
// ledger. Merely matching 117 rows cannot prove the schema/bootstrap identity.
export function verifyCustomLedger(entries,dir=resolve('supabase/migrations')){
 if(!Array.isArray(entries)||entries.length!==117)deny('custom-migration-ledger-count');
 const files=readdirSync(dir).filter(x=>x.endsWith('.sql')).sort();
 if(files.length!==115)deny('migration-source-version-drift');
 const ledger=new Map();
 for(const row of entries){
  if(typeof row?.filename!=='string'||typeof row?.checksum!=='string'||
     ledger.has(row.filename))deny('custom-migration-ledger-invalid');
  ledger.set(row.filename,row.checksum);
 }
 for(const name of files){
  const checksum=createHash('sha256').update(readFileSync(join(dir,name))).digest('hex');
  if(ledger.get(name)!==checksum)deny('custom-migration-checksum:'+name);
  ledger.delete(name);
 }
 const historical=['20261021121500_incomplete_game_review_recovery.sql',
  '20261021121600_resume_oversized_game_specification.sql'];
 if(ledger.size!==2||historical.some(name=>
  !/^[0-9a-f]{64}$/.test(ledger.get(name)||'')))deny('unknown-historical-ledger');
 return true;
}
async function rows(db,table){
 const {count,error}=await db.from(table).select('*',{count:'exact',head:true});
 if(error||!Number.isSafeInteger(count))deny('table-access:'+table);
 return count;
}
async function insert(db,table,item){
 const {data,error}=await db.from(table).insert(item).select('*').single();
 if(error||!data)deny('write:'+table+':'+(error?.code??'unknown'));
 return data;
}
export async function bootstrap({db,ownerId}){
 const {data:ledger,error:ledgerError}=await db.from('schema_migrations')
  .select('filename,checksum');
 if(ledgerError)deny('custom-schema-ledger-unavailable');
 verifyCustomLedger(ledger);
 for(const table of ['actors','chats','benchmark_three_arm_trials',
  'benchmark_budget_accounts','benchmark_native_spending_approvals']){
  if(await rows(db,table)!==0)deny('not-clean-staging:'+table);
 }
 const {data:prices,error:priceError}=await db.from('model_registry')
  .select('model_id,pricing_status,pricing_input_per_1m,pricing_output_per_1m')
  .eq('provider_name','openai').eq('model_id',MODEL).maybeSingle();
 if(priceError||prices?.pricing_status!=='verified')deny('model-price-not-verified');
 const bound=assertBenchmarkDollarCeiling({armUsdCents:1000,
  priceCeilingMicrosPerMillion:PRICE_CEILING,
  publishedInputUsdPerMillion:prices.pricing_input_per_1m,
  publishedOutputUsdPerMillion:prices.pricing_output_per_1m,
  accountTokens:TOKENS,approvalTokens:TOKENS});
 if(bound.maxTokens<TOKENS)deny('owner-usd-cap');
 const protocol=frozenProtocol();
 const experimentId=randomUUID(), actorId=randomUUID(),chatId=randomUUID();
 // Staging-only synthetic actor; not copied from production, and not a claim
 // that the app owner logged into or approved something in a chat.
 await insert(db,'actors',{id:actorId,name:'Take Eleven benchmark isolated actor',
  system_prompt:'Isolated staging benchmark execution identity; no production access.'});
 await insert(db,'chats',{id:chatId,actor_id:actorId,title:'Take Eleven isolated staging trial'});
 const result={experimentId,actorId,chatId,ownerBound:true,model:MODEL,
  tokenCapPerArm:TOKENS,conservativePriceCeilingMicrosPerMillion:PRICE_CEILING,
  totalUsdCeilingCents:3000,baselineSha:BASELINE,arms:[]};
 const deadline=new Date(Date.now()+40*60*1000).toISOString();
 for(const arm of ARMS){
  const trial=await insert(db,'benchmark_three_arm_trials',{
   experiment_id:experimentId,replicate:1,arm,owner_actor_id:actorId,
   baseline_sha:protocol.baselineSha,
   contract_sha256:protocol.contract_sha256,
   acceptance_sha256:protocol.acceptance_sha256,
   tool_profile_sha256:protocol.tool_profile_sha256,
   model_policy_sha256:protocol.model_policy_sha256,
   runtime_sha256:protocol.runtime_sha256,
   state:arm==='full'?'planned':'qualified'
  });
  const account=await insert(db,'benchmark_budget_accounts',{
   experiment_id:experimentId,trial_id:trial.id,arm,owner_actor_id:actorId,
   cap_tokens:TOKENS,spent_tokens:0
  });
  // Full requires actual DO project/task admission and a separate trusted
  // owner approval; never forge project or mission data to qualify it.
  let approvalId=null;
  if(arm!=='full'){
   const approval=await insert(db,'benchmark_native_spending_approvals',{
    owner_id:ownerId,actor_id:actorId,chat_id:chatId,trial_id:trial.id,
    account_id:account.id,repository:REPO,model:MODEL,
    protocol_digest:protocolDigest(trial,TOKENS),
    max_tokens:TOKENS,deadline
   });
   approvalId=approval.id;
  }
  result.arms.push({arm,trialId:trial.id,accountId:account.id,
   approvalId,state:arm==='full'?'planned':'qualified'});
 }
 return result;
}
if(process.argv[1]&&process.argv[1].endsWith('owner-staging-bootstrap.mjs')){
 const destination=process.argv[2];
 if(!destination)deny('receipt-path-required');
 const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
 const ownerId=verifyOwnerEnvironment(process.env,event);
 const db=createClient(process.env.KATIE_NONFULL_STAGING_SUPABASE_URL,
  process.env.KATIE_NONFULL_STAGING_SERVICE_ROLE_KEY,
  {auth:{persistSession:false,autoRefreshToken:false}});
 const result=await bootstrap({db,ownerId});
 writeFileSync(destination,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log('BENCHMARK_OWNER_STAGING_RECORDS_QUALIFIED: native,thin; full=planned');
}
