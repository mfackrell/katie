import {openNativeProductionRuntime} from './native-runtime-capsule.mjs';
// Trusted GitHub Actions host. Never run this file from the candidate worktree.
// For paid execution it requires a separate, previously owner-approved spending
// record and an explicit privileged workflow switch; CI/synthetic jobs cannot pay.
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createNativeHttpBridge} from './native-http-bridge.mjs';
import {createResponsesProvider} from './native-provider-receipts.mjs';
import {assertBenchmarkDollarCeiling} from './paid-dollar-ceiling.mjs';
import {tokenDigest} from './authenticated-native-gateway.mjs';
import {readNativeHandoff} from './native-dispatch-contract.mjs';
import {assertTrustedBoundary,protectedNativeMounts,protectedGitConfig} from './native-trust-boundary.mjs';
import {sharedNativeContainerArgs} from './shared-native-container.mjs';
const require=createRequire(join(process.cwd(),'package.json'));
const {createClient}=require('@supabase/supabase-js');
const [,,requestFile,manifestFile,childFile]=process.argv;
const denied=message=>{throw Error('NATIVE_HOST_DENIED: '+message)};
if(!requestFile||!manifestFile||!childFile)denied('missing verified inputs');
const signingKey=process.env.KATIE_NATIVE_HANDOFF_HMAC_KEY;
const proof=readNativeHandoff(readFileSync(requestFile,'utf8'),signingKey);
const manifest=JSON.parse(readFileSync(manifestFile,'utf8'));
for(const key of ['taskId','trialId','approvalId','projectId','contractHash','benchmarkContractHash','baselineSha','expiresAt'])
 if(manifest[key]!==proof[key])denied('handoff changed after signature verification');
if(manifest.productionRuntime!==proof.productionRuntime)denied('runtime handoff changed after verification');
if(process.env.GITHUB_REPOSITORY!=='mfackrell/katie')denied('repository identity mismatch');
const productionRuntime=proof.productionRuntime?openNativeProductionRuntime(proof.productionRuntime,proof,signingKey):null;
// Production capsules are emitted only by the enabled server dispatcher after
// its task-specific owner approval. Legacy staging retains its separate switch.
if(!productionRuntime&&process.env.KATIE_BENCHMARK_PAID_EXECUTION!=='enabled')
 denied('no separately enabled paid benchmark run');
const url=productionRuntime?.url??process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey=productionRuntime?.serviceRoleKey??process.env.KATIE_BENCHMARK_SERVICE_ROLE_KEY;
if(productionRuntime)process.stdout.write('::add-mask::'+serviceKey+'\n');
const providerKey=process.env.OPENAI_API_KEY;
if(!url||!serviceKey||!providerKey||!process.env.GITHUB_RUN_ID)
 denied('gateway credentials unavailable');
if(!productionRuntime&&url!=='https://iytvavgbaainnsrecmcx.supabase.co')
 denied('benchmark execution is restricted to the authorized staging Supabase project');
const db=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
const readOne=async(table,column,value,fields='*')=>{
 const {data,error}=await db.from(table).select(fields).eq(column,value).maybeSingle();
 if(error||!data)denied('required durable '+table+' record missing');
 return data;
};
const approval=await readOne('benchmark_native_spending_approvals','id',proof.approvalId);
if(approval.trial_id!==proof.trialId||approval.task_id!==proof.taskId||
 approval.project_id!==proof.projectId||approval.repository!==process.env.GITHUB_REPOSITORY||
 approval.revoked_at||approval.consumed_at||new Date(approval.deadline).getTime()<=Date.now())
 denied('owner spending approval is missing or consumed');
const trial=await readOne('benchmark_three_arm_trials','id',proof.trialId);
const project=await readOne('work_projects','id',proof.projectId);
const account=await readOne('benchmark_budget_accounts','id',approval.account_id);
if(productionRuntime){
 const qualification=await readOne('benchmark_production_qualifications','experiment_id',account.experiment_id);
 if(qualification.issue!==715||qualification.revoked_at||qualification.owner_id!==approval.owner_id||
  qualification.actor_id!==approval.actor_id||trial.experiment_id!==qualification.experiment_id||
  new Date(qualification.deadline).getTime()<=Date.now()||
  new Date(approval.deadline).getTime()>new Date(qualification.deadline).getTime())
  denied('production qualification does not authorize this task and deadline');
}
const task=await readOne('agent_tasks','id',proof.taskId);
const dispatch=await readOne('benchmark_development_dispatches','task_id',proof.taskId,
 'task_id,trial_id,contract_hash,benchmark_contract_hash,baseline_sha,status');
// A token-only cap cannot discharge the owner's $10 per-arm approval.
// Verify model pricing AND the independent owner-controlled upper price ceiling
// before issuing any execution grant or allowing any paid provider traffic.
const {data:pricing,error:pricingError}=await db.from('model_registry')
 .select('pricing_input_per_1m,pricing_output_per_1m,pricing_status')
 .eq('provider_name','openai').eq('model_id',approval.model).maybeSingle();
if(pricingError||!pricing||pricing.pricing_status!=='verified')
 denied('model price evidence unavailable');
assertBenchmarkDollarCeiling({
 armUsdCents:productionRuntime?1000:Number(process.env.KATIE_BENCHMARK_APPROVED_ARM_USD_CENTS),
 priceCeilingMicrosPerMillion:productionRuntime?28000000:Number(process.env.KATIE_BENCHMARK_APPROVED_MAX_USD_MICROS_PER_MILLION),
 publishedInputUsdPerMillion:pricing.pricing_input_per_1m,
 publishedOutputUsdPerMillion:pricing.pricing_output_per_1m,
 accountTokens:Number(account.cap_tokens),approvalTokens:Number(approval.max_tokens)
});
if(trial.arm!=='full'||trial.state!=='qualified'||
 trial.contract_sha256!==proof.benchmarkContractHash||trial.baseline_sha!==proof.baselineSha||
 dispatch.trial_id!==proof.trialId||dispatch.contract_hash!==proof.contractHash||
 dispatch.benchmark_contract_hash!==proof.benchmarkContractHash||dispatch.baseline_sha!==proof.baselineSha||dispatch.status!=='qualified'||
 approval.model!=='gpt-5.3-codex'||Number(account.cap_tokens)!==350000||
 trial.owner_actor_id!==approval.actor_id||
 account.trial_id!==trial.id||account.owner_actor_id!==approval.actor_id||
 project.actor_id!==approval.actor_id||project.chat_id!==approval.chat_id||
 project.status!=='running'||project.phase!=='development'||
 project.approved_hash!==project.approval_hash||!project.approved_hash||
 project.deadline<=new Date().toISOString()||
 task.actor_id!==approval.actor_id||task.chat_id!==approval.chat_id)
 denied('trial, project, owner or task state mismatch');
const grantToken=randomBytes(48).toString('base64url');
const {data:grantId,error:issueError}=await db.rpc('benchmark_issue_execution_grant',{
 p_owner:approval.owner_id,p_actor:approval.actor_id,p_chat:approval.chat_id,
 p_trial:proof.trialId,p_approval:proof.approvalId,
 p_repository:approval.repository,p_model:approval.model,
 p_epoch:1,p_deadline:approval.deadline,p_digest:tokenDigest(grantToken)
});
if(issueError||typeof grantId!=='string')denied('atomic owner grant issuance rejected');
const clientToken=randomBytes(32).toString('base64url');
const root=mkdtempSync(join(tmpdir(),'katie-trusted-gateway-'));
const evidencePath=process.env.KATIE_NATIVE_EVIDENCE_FILE;
const decisions=[];
const boundary=assertTrustedBoundary(process.cwd());
const checkpointBranch=process.env.KATIE_NATIVE_CHECKPOINT_BRANCH;
if(!/^agent\/issue-[0-9]+-[0-9]+-[0-9]+$/.test(checkpointBranch||'')||!process.env.GH_TOKEN)
 denied('durable Git checkpoint authority unavailable');
execFileSync('gh',['auth','setup-git'],{env:{PATH:process.env.PATH||'',GH_TOKEN:process.env.GH_TOKEN},timeout:20000});
const git=(...args)=>execFileSync('git',[...protectedGitConfig,...args],{cwd:boundary.root,encoding:'utf8',timeout:20000}).trim();
let trustedCheckpointSha=git('rev-parse','HEAD');
const commitCandidate=(label)=>{
  if(git('rev-parse','HEAD')!==trustedCheckpointSha)
   denied('native agent changed protected Git commit ancestry');
  rmSync(join(process.cwd(),'AGENT_REQUEST.md'),{force:true});
  git('add','-A');
  const toolsRoot=process.env.RUNNER_TEMP;
  if(!toolsRoot)denied('trusted scope tools unavailable');
  execFileSync('node',[join(toolsRoot,'project-tools','project-scope.mjs'),requestFile],{cwd:boundary.root,timeout:20000,stdio:'inherit'});
  execFileSync('node',[join(toolsRoot,'project-tools','recovery-scope.mjs'),requestFile],{cwd:boundary.root,timeout:20000,stdio:'inherit'});
  git('-c','user.name=katie-native-checkpoint','-c','user.email=katie-native-checkpoint@users.noreply.github.com','commit','-m',label);
  const sha=git('rev-parse','HEAD');
  // Scope-verified checkpoint persists outside the short-lived runner before
  // another metered phase begins. GitHub credentials stay in the trusted host.
  git('push','origin',`HEAD:refs/heads/${checkpointBranch}`);
  trustedCheckpointSha=sha;
  return sha;
};
const sockdir=join(root,'sock'),socket=join(sockdir,'gateway.sock');
mkdirSync(sockdir,{mode:0o700});
const perRequestCap=Math.min(20000,Number(approval.max_tokens),Number(account.cap_tokens));
if(!Number.isSafeInteger(perRequestCap)||perRequestCap<=0)denied('invalid frozen request reservation');
const upstream=createResponsesProvider({apiKey:providerKey});
const server=createNativeHttpBridge({
 db,grantToken,trialId:proof.trialId,executionEpoch:1,
 providerNamespace:'openai-responses',upperTokens:perRequestCap,
 upstream,clientToken,fullMission:true,
 recordReceipt:async({requestKey,operationId,namespace,providerRequestId,actualTokens,usage})=>{
  const {data,error}=await db.rpc('benchmark_reconcile_provider_usage',{
   p_call:requestKey,p_linked:true,
   p_provider_request:providerRequestId,p_usage:usage
  });
  if(error||!['settled','overrun'].includes(data))throw Error('NATIVE_LINKED_RECEIPT_NOT_RECONCILED');
 }
});
let child=null,stopTimer=null;
try{
 await new Promise(resolve=>server.listen(socket,resolve));
 const runPhase=async(phase,findings='')=>{
  // All phases reuse the SAME server-side grant and per-request atomic meter.
  // A fresh Codex process/thread is required for independent reviews.
  if(findings)writeFileSync(join(root,'review-findings.txt'),findings,{mode:0o600});
  const reviewing=phase==='review'||phase==='final-review';
  const command='socat TCP-LISTEN:43181,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/gateway/gateway.sock & p=$!; trap "kill $p 2>/dev/null || :" EXIT; node /trusted/native-development-child.mjs';
  const args=sharedNativeContainerArgs({
   workspace:boundary.root,socketDir:sockdir,arm:'full',phase,command,
   readOnly:reviewing,
   extraMounts:[
    ...protectedNativeMounts(boundary),
    '--dir','/trusted',
    '--ro-bind',childFile,'/trusted/native-development-child.mjs',
    '--ro-bind',join(process.env.RUNNER_TEMP,'native-host','shared-native-phase.mjs'),'/trusted/shared-native-phase.mjs',
    '--ro-bind',join(process.env.RUNNER_TEMP,'native-host','shared-native-policy.mjs'),'/trusted/shared-native-policy.mjs',
    ...(findings?['--ro-bind',join(root,'review-findings.txt'),'/trusted/review-findings.txt']:[]),
    '--ro-bind',requestFile,'/trusted/AGENT_REQUEST.md'
   ],
   extraEnv:[
    '--setenv','KATIE_NATIVE_MODEL',approval.model,
    '--setenv','KATIE_NATIVE_BRIDGE_TOKEN',clientToken,
    '--setenv','KATIE_NATIVE_BASELINE_SHA',proof.baselineSha
   ]
  });
  child=spawn('bwrap',args,{env:{PATH:process.env.PATH||''},stdio:['ignore','pipe','pipe']});
  let output='';
  child.stdout.on('data',x=>{process.stdout.write(x);output=(output+x).slice(-20000)});
  child.stderr.on('data',x=>process.stderr.write(x));
  const outcome=await new Promise((resolve,reject)=>{
   child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
  });
  child=null;
  if(outcome.code!==0)denied('native '+phase+' failed; spending holds retained');
  if(!reviewing)return null;
  const marker=output.split('\n').filter(x=>x.startsWith('NATIVE_REVIEW_RESULT=')).at(-1);
  if(!marker)denied('missing independent '+phase+' decision');
  let decision;try{decision=JSON.parse(marker.slice('NATIVE_REVIEW_RESULT='.length))}
  catch{denied('invalid independent review output')}
  if(decision.phase!==phase||!['pass','changes_requested'].includes(decision.verdict)||
     typeof decision.findings!=='string'||!decision.findings.trim())
    denied('invalid independent review verdict');
  decisions.push(decision);
  return decision;
 };
 const safelyRunPhase=async(phase,findings='')=>{
  // One bounded retry only for an interrupted native child, never for a
  // rejected reviewer verdict, missing receipt, expired grant or failed auth.
  for(let attempt=0;attempt<2;attempt++){
   try{return await runPhase(phase,findings)}
   catch(error){
    if(attempt!==0||!/NATIVE_HOST_DENIED: native (implementation|review|repair|final-review) failed; spending holds retained/.test(String(error?.message)))
     throw error;
    const {data:pending,error:ledgerError}=await db.from('benchmark_budget_calls')
      .select('id').eq('account_id',account.id)
      .in('state',['reserved','unresolved']).limit(1);
    if(ledgerError||!Array.isArray(pending)||pending.length)
     denied('native recovery requires authoritative reconciliation of pending provider charges');
    const {data:stillLive,error:liveError}=await db.rpc('benchmark_gateway_execution_live',{
     p_digest:tokenDigest(grantToken),p_trial:proof.trialId,p_epoch:1
    });
    if(liveError||stillLive!==true)denied('native recovery grant stopped or expired');
    // Only commit-stable source is eligible for retry; partial interrupted
    // edits are discarded. All new provider attempts require fresh admission.
    git('reset','--hard',trustedCheckpointSha);
    git('clean','-fd');
    console.log('NATIVE_BOUNDED_CHILD_RECOVERY_FROM_COMMITTED_CHECKPOINT');
   }
  }
 };
 stopTimer=setInterval(async()=>{
  try{
   const [g,p]=await Promise.all([
    readOne('benchmark_execution_grants','id',grantId,'stopped_at,revoked_at,deadline'),
    readOne('work_projects','id',proof.projectId,'status,deadline,approval_hash,approved_hash')
   ]);
   if(g.stopped_at||g.revoked_at||new Date(g.deadline)<=new Date()||
      p.status!=='running'||new Date(p.deadline)<=new Date()||
      !p.approved_hash||p.approved_hash!==p.approval_hash)child?.kill('SIGKILL');
  }catch{child?.kill('SIGKILL')}
 },3000);
 await safelyRunPhase('implementation');
 let candidateHead=commitCandidate('native: checkpoint approved implementation');
 const first=await safelyRunPhase('review');
 if(first.verdict!=='pass'){
  // One bounded repair only. Every retry/request remains metered; any uncertain
  // provider call holds capacity rather than being silently refunded.
  await safelyRunPhase('repair',first.findings);
  candidateHead=commitCandidate('native: checkpoint bounded repair');
  const final=await safelyRunPhase('final-review');
  if(final.verdict!=='pass')denied('independent final review requires changes');
 } 
 if(!evidencePath||!evidencePath.startsWith(process.env.RUNNER_TEMP+'/'))
  denied('trusted evidence destination unavailable');
 writeFileSync(evidencePath,JSON.stringify({version:1,trialId:proof.trialId,taskId:proof.taskId,
  approvalId:proof.approvalId,projectId:proof.projectId,review:decisions[0],
  finalReview:decisions.at(-1),repairPerformed:decisions.length===2,
  metered:true,completed:true,reviewedHeadSha:candidateHead})+'\n',{mode:0o600,flag:'wx'});
 console.log('NATIVE_METERED_REVIEW_AND_BOUNDED_REPAIR_COMPLETED');
 console.log('NATIVE_DEVELOPER_RETURNED_TO_EXISTING_TEST_REVIEW_PIPELINE');
}finally{
 if(stopTimer)clearInterval(stopTimer);
 if(child&&!child.killed)child.kill('SIGKILL');
 await new Promise(resolve=>server.close(resolve));
 rmSync(root,{recursive:true,force:true});
}
