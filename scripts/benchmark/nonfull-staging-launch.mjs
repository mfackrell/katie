// Owner-only, explicitly staged Native/Thin qualification. This deliberately
// refuses production credentials and never forwards requests to a paid provider.
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {runNonFullAuthorizedHost} from './nonfull-authorized-host.mjs';
const require=createRequire(join(process.cwd(),'package.json'));
const {createClient}=require('@supabase/supabase-js');
const [,,arm,trialId,accountId,approvalId]=process.argv;
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
if(!['native','thin'].includes(arm)||![trialId,accountId,approvalId].every(x=>uuid.test(x||''))||
 process.env.GITHUB_REPOSITORY!=='mfackrell/katie'||
 process.env.GITHUB_ACTOR?.toLowerCase()!==process.env.GITHUB_REPOSITORY_OWNER?.toLowerCase()||
 process.env.KATIE_NONFULL_STAGING_ONLY!=='verified'||
 process.env.KATIE_BENCHMARK_PAID_EXECUTION!=='disabled'||
 process.env.OPENAI_API_KEY||process.env.CODEX_ACCESS_TOKEN)
 throw Error('NONFULL_STAGING_LAUNCH_DENIED');
const url=process.env.KATIE_NONFULL_STAGING_SUPABASE_URL;
const key=process.env.KATIE_NONFULL_STAGING_SERVICE_ROLE_KEY;
const ownerId=process.env.KATIE_NONFULL_STAGING_OWNER_ID;
const productionUrl=process.env.KATIE_NONFULL_PRODUCTION_SUPABASE_URL;
if(!url||!key||!ownerId||!productionUrl||!url.startsWith('https://')||
 url===productionUrl||
 url===process.env.NEXT_PUBLIC_SUPABASE_URL||
 url===process.env.KATIE_BENCHMARK_SUPABASE_URL)
 throw Error('NONFULL_STAGING_DATABASE_NOT_ATTESTED');
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
async function load(table,id){
 const {data,error}=await db.from(table).select('*').eq('id',id).maybeSingle();
 if(error||!data)throw Error('NONFULL_STAGING_IDENTITY_MISSING:'+table);
 return data;
}
const [trial,account,approval]=await Promise.all([
 load('benchmark_three_arm_trials',trialId),
 load('benchmark_budget_accounts',accountId),
 load('benchmark_native_spending_approvals',approvalId)
]);
const workspace=mkdtempSync(join(tmpdir(),'qualified-native-'));
let callCount=0;
const upstream=async request=>{
 callCount++;
 const reply=callCount===2?'CHANGES_REQUESTED: synthetic acceptance fixture':
  callCount===4?'PASS: synthetic repair accepted':'DONE';
 const item={id:'message_'+callCount,type:'message',role:'assistant',status:'completed',
  content:[{type:'output_text',text:reply,annotations:[]}]};
 const response={id:'nonbillable-'+trialId+'-'+callCount,object:'response',
  created_at:1,model:request.model,status:'completed',output:[item],
  usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
 const events=[
  ['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],
  ['response.output_item.added',{type:'response.output_item.added',output_index:0,item}],
  ['response.output_item.done',{type:'response.output_item.done',output_index:0,item}],
  ['response.completed',{type:'response.completed',response}]
 ];
 return {providerRequestId:response.id,actualTokens:5,contentType:'text/event-stream',
  body:events.map(([event,value])=>'event: '+event+'\ndata: '+JSON.stringify(value)+'\n\n').join('')+'data: [DONE]\n\n'};
};
upstream.nonbillableFixture=true;
try{
 // Never use candidate-controlled checkout metadata or modules as the host.
 execFileSync('git',['clone','--no-hardlinks','--quiet',process.cwd(),workspace],{timeout:30000});
 execFileSync('git',['-c','core.hooksPath=/dev/null','-C',workspace,'checkout','--detach',trial.baseline_sha],{timeout:30000});
 mkdirSync(join(workspace,'node_modules'));
 const result=await runNonFullAuthorizedHost({db,arm,trial,account,approval,
  ownerId,repository:process.env.GITHUB_REPOSITORY,workspace,upstream,
  model:approval.model});
 if(result.phases.length!==4||callCount!==4||
    result.phases.some(x=>x.code!==0))
  throw Error('NONFULL_STAGING_ACCEPTANCE_INCOMPLETE');
 // Read authoritative staging records AFTER the actual trusted host returns.
 const [calls,settledAccount,consumedApproval,runningTrial]=await Promise.all([
  db.from('benchmark_budget_calls').select('id,state,actual_tokens,provider_request_id,provider_namespace').eq('account_id',accountId),
  db.from('benchmark_budget_accounts').select('spent_tokens,frozen_at').eq('id',accountId).single(),
  db.from('benchmark_native_spending_approvals').select('consumed_at').eq('id',approvalId).single(),
  db.from('benchmark_three_arm_trials').select('state').eq('id',trialId).single()
 ]);
 if(calls.error||settledAccount.error||consumedApproval.error||runningTrial.error||
    calls.data?.length!==4||
    !calls.data.every(c=>c.state==='settled'&&Number(c.actual_tokens)===5&&
      typeof c.provider_request_id==='string'&&
      c.provider_namespace==='nonbillable-synthetic-fixture')||
    new Set(calls.data.map(x=>x.provider_request_id)).size!==4||
    Number(settledAccount.data?.spent_tokens)!==20||
    settledAccount.data?.frozen_at||
    !consumedApproval.data?.consumed_at||runningTrial.data?.state!=='running')
  throw Error('NONFULL_STAGING_LEDGER_RECONCILIATION_FAILED');
 const receipt={version:1,arm,trialId:result.trialId,accountId,
  grantId:result.grantId,completedPhases:result.phases.length,
  settledReceipts:4,actualTokens:20,nonbillable:true,accepted:false,
  authoritativeLedger:'staging',reviewRequired:true,
  commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()};
 const evidence=join(process.env.RUNNER_TEMP||'/dev/null','nonfull-staging-acceptance.json');
 writeFileSync(evidence,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
 console.log('NONFULL_STAGING_CANONICAL_RECEIPTS_VERIFIED:'+arm);
}finally{rmSync(workspace,{recursive:true,force:true})}
