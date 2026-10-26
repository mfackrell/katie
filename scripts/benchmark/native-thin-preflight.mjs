// Privileged read-only Native/Thin admission preflight. Run by owner-only
// GitHub Actions job before ANY SDK process is launched.
import {createRequire} from 'node:module';
import {verifyNonFullLaunch} from './arm-launch-authority.mjs';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const require=createRequire(resolve('package.json'));
const {createClient}=require('@supabase/supabase-js');
const [,,arm,trialId,accountId,approvalId,destination]=process.argv;
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
if(!['native','thin'].includes(arm)||![trialId,accountId,approvalId].every(x=>uuid.test(x||''))||
 !destination||process.env.GITHUB_REPOSITORY!=='mfackrell/katie'||
 process.env.GITHUB_ACTOR?.toLowerCase()!==process.env.GITHUB_REPOSITORY_OWNER?.toLowerCase()||
 process.env.KATIE_BENCHMARK_PAID_EXECUTION==='enabled')
 throw Error('NONFULL_PREFLIGHT_DENIED');
const url=process.env.KATIE_BENCHMARK_SUPABASE_URL;
const key=process.env.KATIE_BENCHMARK_SERVICE_ROLE_KEY;
const ownerId=process.env.KATIE_BENCHMARK_OWNER_ID;
if(!url||!key||!ownerId)throw Error('NONFULL_TRUSTED_DB_AUTHORITY_MISSING');
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
async function load(table,id){
 const {data,error}=await db.from(table).select('*').eq('id',id).maybeSingle();
 if(error||!data)throw Error('NONFULL_DURABLE_AUTHORITY_MISSING:'+table);
 return data;
}
const [trial,account,approval]=await Promise.all([
 load('benchmark_three_arm_trials',trialId),
 load('benchmark_budget_accounts',accountId),
 load('benchmark_native_spending_approvals',approvalId)
]);
const verified=verifyNonFullLaunch({arm,trial,account,approval,ownerId,
 repository:process.env.GITHUB_REPOSITORY});
const parent=resolve(process.env.RUNNER_TEMP||'/dev/null');
const target=resolve(destination);
if(!target.startsWith(parent+'/'))throw Error('NONFULL_OUTPUT_NOT_TRUSTED');
writeFileSync(target,JSON.stringify({...verified,baselineSha:trial.baseline_sha,
 contractHash:trial.contract_sha256,qualification:'nonbillable-only',
 requiresNewGrantBeforePaidExecution:true})+'\n',{mode:0o600,flag:'wx'});
console.log('NONFULL_OWNER_TRIAL_PREFLIGHT_PASS:'+arm);
