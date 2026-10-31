import {executeNativeDevelopmentLifecycle} from './native-development-lifecycle.mjs';
import {recoveryCompletedEvidence,recoveryRefs,loadRecoveryDiagnostics,validateRecoveryRecords,prepareRecovery,githubRecoveryReader} from './native-wip-recovery.mjs';
import {createNativeWipCheckpointer} from './native-wip-checkpoint.mjs';
import {sanitizeEvidence,worktreeEvidence,NATIVE_EXECUTION_EVIDENCE_VERSION} from './native-execution-evidence.mjs';
import {NATIVE_ADMISSION_DIAGNOSTICS_VERSION} from './native-request-admission.mjs';
import {preflightNativeChild} from './native-child-preflight.mjs';
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
import {createNativeHttpBridge,nativeChildInterruptionRetryable} from './native-http-bridge.mjs';
import {createResponsesProvider,NATIVE_INPUT_COUNT_VERSION} from './native-provider-receipts.mjs';
import {assertBenchmarkDollarCeiling,readVerifiedBenchmarkPricing} from './paid-dollar-ceiling.mjs';
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
for(const key of ['taskId','trialId','approvalId','projectId','contractHash','benchmarkContractHash','baselineSha','expiresAt','continuationId','startupRecoveryId','developmentRenewalId','pregrantRecoveryId','paidSuccessorId','resourceAmendmentId'])
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
 approval.revoked_at||((proof.startupRecoveryId||proof.paidSuccessorId)?!approval.consumed_at:Boolean(approval.consumed_at))||new Date(approval.deadline).getTime()<=Date.now())
 denied('owner spending approval is missing or consumed');
const trial=await readOne('benchmark_three_arm_trials','id',proof.trialId);
const project=await readOne('work_projects','id',proof.projectId);
const account=await readOne('benchmark_budget_accounts','id',approval.account_id);
if((approval.continuation_id??undefined)!==proof.continuationId)denied('continuation identity differs from owner approval');
let continuation=null;
if(proof.continuationId){
 if(!productionRuntime)denied('continuation requires production runtime');
 const live=await db.rpc('benchmark_continuation_live',{p_id:proof.continuationId,p_account:account.id,p_project:project.id});
 if(live.error||live.data!==true)denied('continuation authority is not live');
 const active=await db.rpc('benchmark_active_full_continuation',{p_project:project.id});
 continuation=active.data;
 if(active.error||!continuation||continuation.id!==proof.continuationId||continuation.owner_id!==approval.owner_id||continuation.trial_id!==trial.id||continuation.account_id!==account.id||new Date(approval.deadline)>new Date(continuation.deadline))denied('continuation owner or deadline mismatch');
}

if(productionRuntime){
 const qualification=await readOne('benchmark_production_qualifications','experiment_id',account.experiment_id);
 if(qualification.issue!==715||qualification.revoked_at||qualification.owner_id!==approval.owner_id||
  qualification.actor_id!==approval.actor_id||trial.experiment_id!==qualification.experiment_id||
  (!continuation&&(new Date(qualification.deadline).getTime()<=Date.now()||
  new Date(approval.deadline).getTime()>new Date(qualification.deadline).getTime())))
  denied('production qualification does not authorize this task and deadline');
}
const task=await readOne('agent_tasks','id',proof.taskId);
if(proof.startupRecoveryId){
 if(!productionRuntime)denied('startup recovery requires production runtime');
 const recovery=await readOne('benchmark_startup_recoveries','id',proof.startupRecoveryId);
 if(recovery.approval_id!==proof.approvalId||recovery.task_id!==proof.taskId||
    !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??'')||recovery.release_sha!==process.env.GITHUB_SHA||
    task.external?.startupRecoveryId!==proof.startupRecoveryId)
  denied('startup recovery task, approval or release mismatch');
}

const dispatch=await readOne('benchmark_development_dispatches','task_id',proof.taskId,
 'task_id,trial_id,contract_hash,benchmark_contract_hash,baseline_sha,status');
// A token-only cap cannot discharge the owner's $10 per-arm approval.
// Verify model pricing AND the independent owner-controlled upper price ceiling
// before issuing any execution grant or allowing any paid provider traffic.
const pricing=await readVerifiedBenchmarkPricing(signal=>db.from('model_registry')
 .select('pricing_input_per_1m,pricing_output_per_1m,pricing_status')
 .eq('provider_name','openai').eq('model_id',approval.model).abortSignal(signal).maybeSingle());
if([5,6].includes(continuation?.plan?.version)){
 const cumulativeCap=continuation.plan.version===6?625000:550000;
 const control=await db.rpc('benchmark_full_monetary_control',{p_account:account.id,p_continuation:continuation.id});
 if(control.error||control.data?.version!=='atomic-exposure-v1'||control.data.cumulativeTokenCap!==cumulativeCap||control.data.dollarCeilingMicrousd!==10000000||Number(approval.max_tokens)!==cumulativeCap)denied('atomic cumulative monetary control unavailable');
}else assertBenchmarkDollarCeiling({
 armUsdCents:productionRuntime?1000:Number(process.env.KATIE_BENCHMARK_APPROVED_ARM_USD_CENTS),
 priceCeilingMicrosPerMillion:productionRuntime?28000000:Number(process.env.KATIE_BENCHMARK_APPROVED_MAX_USD_MICROS_PER_MILLION),
 publishedInputUsdPerMillion:pricing.pricing_input_per_1m,
 publishedOutputUsdPerMillion:pricing.pricing_output_per_1m,
 accountTokens:Number(account.cap_tokens),approvalTokens:Number(approval.max_tokens)
});
let delegatedTask=false;
if(task.actor_id!==approval.actor_id||task.chat_id!==approval.chat_id){
 const {data,error}=await db.rpc('benchmark_full_task_provenance',{p_task:task.id,p_project:project.id});
 delegatedTask=!error&&data===true;
}
if(trial.arm!=='full'||(!continuation&&trial.state!=='qualified')||
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
 ((task.actor_id!==approval.actor_id||task.chat_id!==approval.chat_id)&&!delegatedTask))
 denied('trial, project, owner or task state mismatch');
// Complete local checkpoint setup before consuming owner execution authority.
const boundary=assertTrustedBoundary(process.cwd());
const checkpointBranch=process.env.KATIE_NATIVE_CHECKPOINT_BRANCH;
if(!/^agent\/issue-[0-9]+-[0-9]+-[0-9]+$/.test(checkpointBranch||'')||!process.env.GH_TOKEN)
 denied('durable Git checkpoint authority unavailable');
if(!process.env.HOME)denied('trusted host HOME unavailable');
execFileSync('gh',['auth','setup-git'],{env:{PATH:process.env.PATH||'',HOME:process.env.HOME,GH_TOKEN:process.env.GH_TOKEN},timeout:20000});
preflightNativeChild(boundary,childFile);
if(proof.developmentRenewalId){
 if(!productionRuntime||proof.startupRecoveryId)denied('invalid development renewal transport');
 const renewal=await readOne('benchmark_development_renewals','id',proof.developmentRenewalId);
 if(renewal.approval_id!==proof.approvalId||renewal.task_id!==proof.taskId||renewal.continuation_id!==proof.continuationId||task.external?.developmentRenewalId!==renewal.id)denied('development renewal identity mismatch');
}
if(proof.pregrantRecoveryId){
 if(!productionRuntime||!proof.developmentRenewalId||proof.startupRecoveryId)denied('invalid pregrant recovery transport');
 const recovery=await readOne('benchmark_development_pregrant_recoveries','id',proof.pregrantRecoveryId);
 if(recovery.renewal_id!==proof.developmentRenewalId||recovery.release_sha!==process.env.GITHUB_SHA||task.external?.pregrantRecoveryId!==recovery.id)denied('pregrant recovery identity or release mismatch');
}
let ownerApprovedSuccessor=continuation?.plan?.capacityRenewal===true;
if(proof.paidSuccessorId){
 if(!productionRuntime||!proof.developmentRenewalId||proof.startupRecoveryId||proof.pregrantRecoveryId||process.env.KATIE_BENCHMARK_GATEWAY_DIAGNOSTICS!=='enabled'||NATIVE_ADMISSION_DIAGNOSTICS_VERSION!=='bounded-schema-v1')denied('instrumented paid successor transport required');
 const successor=await readOne('benchmark_development_paid_successors','id',proof.paidSuccessorId);
 const consent=await db.from('benchmark_amendment_successor_consents').select('id').eq('renewal_id',proof.developmentRenewalId).maybeSingle();
 if(consent.error)denied('successor consent inspection unavailable');
 ownerApprovedSuccessor=Boolean(consent.data);
 if(successor.renewal_id!==proof.developmentRenewalId||successor.release_sha!==process.env.GITHUB_SHA||successor.diagnostic_version!==NATIVE_ADMISSION_DIAGNOSTICS_VERSION||task.external?.paidSuccessorId!==successor.id)denied('paid successor identity or release mismatch');
}
if(proof.resourceAmendmentId){
 if(!productionRuntime||!proof.developmentRenewalId||proof.startupRecoveryId||proof.pregrantRecoveryId||proof.paidSuccessorId)denied('invalid resource amendment transport');
 const amendment=await readOne('benchmark_development_resource_amendments','id',proof.resourceAmendmentId);
 if(amendment.renewal_id!==proof.developmentRenewalId||amendment.approval_id!==proof.approvalId||amendment.task_id!==proof.taskId||amendment.continuation_id!==proof.continuationId||amendment.release_sha!==process.env.GITHUB_SHA||amendment.runtime_version!==NATIVE_INPUT_COUNT_VERSION||task.external?.resourceAmendmentId!==amendment.id)denied('resource amendment identity or release mismatch');
}
// Inspect recovery before consuming a fresh owner grant. The service-owned
// failed-run receipt and its immutable diagnostics authenticate the Git object.
const wipContext=JSON.parse(execFileSync(process.execPath,[join(process.env.RUNNER_TEMP,'project-tools','project-context.mjs'),'prepare',requestFile],{encoding:'utf8',timeout:20000}));
const priorRefs=recoveryRefs(boundary.root,task.id);
let recoveryPlan=null;
if(priorRefs.length||task.external?.receipt?.outcome==='BLOCKED'){
 const {record,diagnostics:priorDiagnostics}=await loadRecoveryDiagnostics({task,repository:process.env.GITHUB_REPOSITORY,github:githubRecoveryReader(process.env.GITHUB_REPOSITORY)});
 const completedEvidence=recoveryCompletedEvidence(record,priorDiagnostics);
 await validateRecoveryRecords({completedEvidence,record,task,context:wipContext,project,trialId:proof.trialId,accountId:account.id,readOne});
 recoveryPlan=prepareRecovery({completedEvidence,workspace:boundary.root,tempRoot:process.env.RUNNER_TEMP,toolsRoot:join(process.env.RUNNER_TEMP,'project-tools'),requestFile,context:wipContext,record,refs:priorRefs});
}
// Source restoration is nonbillable and must succeed before consuming consent.
const recovery=recoveryPlan?.restore()??null;
const grantToken=randomBytes(48).toString('base64url');
if(proof.startupRecoveryId&&!productionRuntime)denied('startup recovery requires production runtime');
const {data:grantResult,error:issueError}=proof.resourceAmendmentId
 ?await db.rpc('benchmark_issue_development_amendment_grant',{p_amendment:proof.resourceAmendmentId,p_digest:tokenDigest(grantToken),p_approval:proof.approvalId,p_task:proof.taskId,p_release:process.env.GITHUB_SHA})
 :proof.paidSuccessorId
 ?await db.rpc('benchmark_issue_development_paid_successor_grant',{p_successor:proof.paidSuccessorId,p_digest:tokenDigest(grantToken),p_approval:proof.approvalId,p_task:proof.taskId,p_release:process.env.GITHUB_SHA})
 :proof.pregrantRecoveryId
 ?await db.rpc('benchmark_issue_development_pregrant_recovery_grant',{p_recovery:proof.pregrantRecoveryId,p_digest:tokenDigest(grantToken),p_approval:proof.approvalId,p_task:proof.taskId,p_release:process.env.GITHUB_SHA})
 :proof.developmentRenewalId
 ?await db.rpc('benchmark_issue_development_renewal_grant',{p_renewal:proof.developmentRenewalId,p_digest:tokenDigest(grantToken),p_approval:proof.approvalId,p_task:proof.taskId,p_release:process.env.GITHUB_SHA})
 :proof.startupRecoveryId
 ?await db.rpc('benchmark_issue_startup_recovery_grant',{p_recovery:proof.startupRecoveryId,p_digest:tokenDigest(grantToken),p_approval:proof.approvalId,p_task:proof.taskId,p_release:process.env.GITHUB_SHA})
 :await db.rpc('benchmark_issue_execution_grant',{
 p_owner:approval.owner_id,p_actor:approval.actor_id,p_chat:approval.chat_id,
 p_trial:proof.trialId,p_approval:proof.approvalId,
 p_repository:approval.repository,p_model:approval.model,
 p_epoch:1,p_deadline:approval.deadline,p_digest:tokenDigest(grantToken)
});
const grantId=(proof.startupRecoveryId||proof.developmentRenewalId)?grantResult?.grantId:grantResult;
const executionEpoch=(proof.startupRecoveryId||proof.developmentRenewalId)?grantResult?.executionEpoch:1;
if(issueError||typeof grantId!=='string'||!Number.isSafeInteger(executionEpoch)||executionEpoch<1)denied('atomic owner grant issuance rejected');
const clientToken=randomBytes(32).toString('base64url');
const root=mkdtempSync(join(tmpdir(),'katie-trusted-gateway-'));
const evidencePath=process.env.KATIE_NATIVE_EVIDENCE_FILE;
const diagnostics={version:NATIVE_EXECUTION_EVIDENCE_VERSION,runId:process.env.GITHUB_RUN_ID,taskId:proof.taskId,phases:[],snapshots:[],scope:[],completed:false};
const diagnosticSecrets=[providerKey,serviceKey,signingKey,grantToken,clientToken,process.env.GH_TOKEN];
const snapshot=label=>diagnostics.snapshots.push({label,...worktreeEvidence(boundary.root,diagnosticSecrets)});
const saveDiagnostics=()=>{if(evidencePath&&evidencePath.startsWith(process.env.RUNNER_TEMP+'/'))writeFileSync(evidencePath+'.diagnostics.json',JSON.stringify(diagnostics)+'\n',{mode:0o600});};
snapshot('initial');saveDiagnostics();
const git=(...args)=>execFileSync('git',[...protectedGitConfig,...args],{cwd:boundary.root,encoding:'utf8',timeout:20000}).trim();
let trustedCheckpointSha=git('rev-parse','HEAD');
let activeWipPhase=null,lastCompleted=recovery?.lastCompleted??{checkpointSha:trustedCheckpointSha};
if(recovery){diagnostics.recovery={verification:'unverified',phase:recovery.phase,checkpointSha:recovery.checkpointSha,completedCheckpointSha:trustedCheckpointSha};saveDiagnostics();}
const wip=createNativeWipCheckpointer({workspace:boundary.root,tempRoot:root,
 toolsRoot:join(process.env.RUNNER_TEMP,'project-tools'),requestFile,context:wipContext,
 identity:{taskId:proof.taskId,projectId:proof.projectId,trialId:proof.trialId,
  approvalId:proof.approvalId,grantId,executionEpoch,approvedScopeHash:project.approved_hash,
  runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT||'1'},
 secrets:diagnosticSecrets,expectedHead:()=>trustedCheckpointSha});
const preserveWip=()=>{
 if(!activeWipPhase)return;
 try{
  const checkpoint=wip.save({...activeWipPhase,lastCompleted});
  if(checkpoint){diagnostics.wipCheckpoint=checkpoint;saveDiagnostics();}
 }catch{diagnostics.wipFailure='NATIVE_WIP_CHECKPOINT_DENIED';saveDiagnostics();throw Error('NATIVE_WIP_CHECKPOINT_DENIED');}
};
const commitCandidate=(label)=>{
  if(git('rev-parse','HEAD')!==trustedCheckpointSha)
   denied('native agent changed protected Git commit ancestry');
  rmSync(join(process.cwd(),'AGENT_REQUEST.md'),{force:true});
  git('add','-A');
  const toolsRoot=process.env.RUNNER_TEMP;
  if(!toolsRoot)denied('trusted scope tools unavailable');
  snapshot('before-scope');
  try{execFileSync('node',[join(toolsRoot,'project-tools','project-scope.mjs'),requestFile],{cwd:boundary.root,timeout:20000,stdio:'pipe'});diagnostics.scope.push({passed:true});}
  catch(error){diagnostics.scope.push({passed:false,detail:sanitizeEvidence(error.stderr?.toString()||error.message,diagnosticSecrets)});saveDiagnostics();throw Error('NATIVE_PROJECT_SCOPE_FAILED: see retained diagnostics');}
  execFileSync('node',[join(toolsRoot,'project-tools','recovery-scope.mjs'),requestFile],{cwd:boundary.root,timeout:20000,stdio:'inherit'});
  git('-c','user.name=katie-native-checkpoint','-c','user.email=katie-native-checkpoint@users.noreply.github.com','commit','-m',label);
  const sha=git('rev-parse','HEAD');
  // Scope-verified checkpoint persists outside the short-lived runner before
  // another metered phase begins. GitHub credentials stay in the trusted host.
  git('push','origin',`HEAD:refs/heads/${checkpointBranch}`);
  trustedCheckpointSha=sha;
  activeWipPhase=null;
  lastCompleted={...lastCompleted,checkpointSha:sha};
  return sha;
};
const sockdir=join(root,'sock'),socket=join(sockdir,'gateway.sock');
mkdirSync(sockdir,{mode:0o700});
const perRequestCap=Math.min(120000,Number(approval.max_tokens),Number(account.cap_tokens));
if(!Number.isSafeInteger(perRequestCap)||perRequestCap<=0)denied('invalid frozen request reservation');
const upstream=createResponsesProvider({apiKey:providerKey});
let gatewayFailure=null;
const server=createNativeHttpBridge({
 beforeRequest:preserveWip,
 onFailure:classification=>{gatewayFailure??=classification;},
 requireInputCount:true,
 db,grantToken,trialId:proof.trialId,executionEpoch,
 providerNamespace:'openai-responses',upperTokens:perRequestCap,
 upstream,clientToken,fullMission:true,
 recordReceipt:async({requestKey,operationId,namespace,providerRequestId,actualTokens,usage})=>{
  const {data,error}=await db.rpc('benchmark_reconcile_provider_usage',{
   p_call:requestKey,p_linked:true,
   p_provider_request:providerRequestId,p_usage:usage
  });
  if(error||!['settled','overrun'].includes(data))throw Error('NATIVE_LINKED_RECEIPT_NOT_RECONCILED');
  lastCompleted={...lastCompleted,modelCall:{requestKey,operationId,actualTokens,settlement:data}};
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
  activeWipPhase=reviewing?null:{phase,reviewFindings:findings};
  const command='socat TCP-LISTEN:43181,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/gateway/gateway.sock & p=$!; trap "kill $p 2>/dev/null || :" EXIT; node /trusted/native-development-child.mjs';
  const args=sharedNativeContainerArgs({
   workspace:boundary.root,socketDir:sockdir,arm:'full',phase,command,
   readOnly:reviewing,
   extraMounts:[
    ...protectedNativeMounts(boundary),
    '--dir','/trusted',
    '--ro-bind',childFile,'/trusted/native-development-child.mjs',
    '--ro-bind',join(process.env.RUNNER_TEMP,'native-host','native-execution-evidence.mjs'),'/trusted/native-execution-evidence.mjs',
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
  let output='',pending='';
  const phaseEvidence={phase,events:[],dropped:0};diagnostics.phases.push(phaseEvidence);
  child.stdout.on('data',x=>{output=(output+x).slice(-20000);pending=(pending+x).slice(-32768);let newline;while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(line.startsWith('NATIVE_EXECUTION_EVENT=')){try{const event=JSON.parse(line.slice('NATIVE_EXECUTION_EVENT='.length));if(event.itemType==='agent_message'&&event.event==='item.completed')phaseEvidence.finalMessage=sanitizeEvidence(event.message,diagnosticSecrets);if(['turn.failed','turn.completed','error'].includes(event.event))phaseEvidence.terminalEvent=event.event;if(phaseEvidence.events.length<120)phaseEvidence.events.push(JSON.parse(JSON.stringify(event,(_key,value)=>typeof value==='string'?sanitizeEvidence(value,diagnosticSecrets):value)));else phaseEvidence.dropped++;}catch{}saveDiagnostics();}}});
  child.stderr.on('data',x=>{phaseEvidence.stderr=sanitizeEvidence(x.toString(),diagnosticSecrets);saveDiagnostics();});
  const outcome=await new Promise((resolve,reject)=>{
   child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
  });
  child=null;phaseEvidence.outcome=outcome;snapshot('after-'+phase);saveDiagnostics();
  preserveWip();
  if(outcome.code!==0)throw Object.assign(new Error('NATIVE_HOST_DENIED: native '+phase+' failed; spending holds retained'),{nativeChildOutcome:outcome});
  lastCompleted={...lastCompleted,phase};
  if(!reviewing)return null;
  const marker=output.split('\n').filter(x=>x.startsWith('NATIVE_REVIEW_RESULT=')).at(-1);
  if(!marker)denied('missing independent '+phase+' decision');
  let decision;try{decision=JSON.parse(marker.slice('NATIVE_REVIEW_RESULT='.length))}
  catch{denied('invalid independent review output')}
  if(decision.phase!==phase||!['pass','changes_requested'].includes(decision.verdict)||
     typeof decision.findings!=='string'||!decision.findings.trim())
    denied('invalid independent review verdict');
  decision.findings=sanitizeEvidence(decision.findings,diagnosticSecrets,12000);
  return decision;
 };
 const safelyRunPhase=async(phase,findings='')=>{
  // Retry only a positively identified process interruption. Any gateway denial,
  // uncertain upstream result, ordinary nonzero exit or intentional stop is final.
  for(let attempt=0;attempt<(ownerApprovedSuccessor?1:2);attempt++){
   try{return await runPhase(phase,findings)}
   catch(error){
    if(ownerApprovedSuccessor||attempt!==0||!nativeChildInterruptionRetryable(error?.nativeChildOutcome,gatewayFailure))
     throw error;
    const {data:pending,error:ledgerError}=await db.from('benchmark_budget_calls')
      .select('id').eq('account_id',account.id)
      .in('state',['reserved','unresolved']).limit(1);
    if(ledgerError||!Array.isArray(pending)||pending.length)
     denied('native recovery requires authoritative reconciliation of pending provider charges');
    const {data:stillLive,error:liveError}=await db.rpc('benchmark_gateway_execution_live',{
     p_digest:tokenDigest(grantToken),p_trial:proof.trialId,p_epoch:executionEpoch
    });
    if(liveError||stillLive!==true)denied('native recovery grant stopped or expired');
    // Only commit-stable source is eligible for retry; partial interrupted
    // edits are retained in separate unverified WIP tags before reset.
    // All new provider attempts still require fresh admission.
    snapshot('before-interruption-reset');saveDiagnostics();
    git('reset','--hard',trustedCheckpointSha);
    git('clean','-fd');snapshot('after-interruption-reset');saveDiagnostics();
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
      !p.approved_hash||p.approved_hash!==p.approval_hash){gatewayFailure??='host-stop';child?.kill('SIGKILL');}
  }catch{gatewayFailure??='host-stop';child?.kill('SIGKILL')}
 },3000);
 // Run the existing trusted deterministic/build/browser verifier before the
 // one paid correction. Candidate commands remain inside its credential-free sandbox.
 const verifyCandidate=async(candidateHead)=>{
  const output=join(root,'project-acceptance.json');
  const failure=join(root,'project-verification-failure.json');
  rmSync(output,{force:true});rmSync(failure,{force:true});
  const verifier=spawn(process.execPath,[join(process.env.RUNNER_TEMP,'project-tools','project-ci.mjs'),'--request',requestFile,'--output',output],{
   cwd:boundary.root,timeout:2100000,killSignal:'SIGKILL',env:{PATH:process.env.PATH||'',RUNNER_TEMP:process.env.RUNNER_TEMP,CI:'true'},stdio:['ignore','pipe','pipe']});
  child=verifier;let log='';
  for(const stream of [verifier.stdout,verifier.stderr])stream.on('data',x=>{log=(log+x).slice(-16000);});
  const code=await new Promise((resolve,reject)=>{verifier.once('error',reject);verifier.once('close',resolve);});child=null;
  const result={passed:code===0,detail:sanitizeEvidence(log,diagnosticSecrets,12000)};
  diagnostics.verification??=[];diagnostics.verification.push({head:candidateHead,...result});saveDiagnostics();
  if(gatewayFailure||code===null)denied('deterministic verification interrupted');
  try{if(JSON.parse(readFileSync(failure,'utf8')).kind==='infrastructure')denied('deterministic verification infrastructure failed before candidate tests');}catch(error){if(error.message?.startsWith('NATIVE_HOST_DENIED'))throw error;}
  return result;
 };
 const qualifiedLifecycle=continuation?.plan?.capacityRenewal===true;
 const lifecycle=await executeNativeDevelopmentLifecycle({recovery,runPhase:safelyRunPhase,commitCandidate,verifyCandidate,qualifiedLifecycle,
  onCompleted:evidence=>{lastCompleted={...lastCompleted,...evidence};}});
 if(!evidencePath||!evidencePath.startsWith(process.env.RUNNER_TEMP+'/'))
  denied('trusted evidence destination unavailable');
 writeFileSync(evidencePath,JSON.stringify({version:1,trialId:proof.trialId,taskId:proof.taskId,...(proof.continuationId?{continuationId:proof.continuationId}:{}),
  approvalId:proof.approvalId,projectId:proof.projectId,review:lifecycle.review,
  finalReview:lifecycle.finalReview,repairPerformed:lifecycle.repairPerformed,repairVerification:lifecycle.repairVerification,
  metered:true,completed:true,reviewedHeadSha:lifecycle.candidateHead})+'\n',{mode:0o600,flag:'wx'});
 diagnostics.completed=true;
 console.log('NATIVE_METERED_REVIEW_AND_BOUNDED_REPAIR_COMPLETED');
 console.log('NATIVE_DEVELOPER_RETURNED_TO_EXISTING_TEST_REVIEW_PIPELINE');
}catch(error){diagnostics.failure=sanitizeEvidence(error.message,diagnosticSecrets);throw error;}finally{
 try{preserveWip();}catch{/* Failure is retained; never masks the original denial. */}
 snapshot('final');saveDiagnostics();
 if(stopTimer)clearInterval(stopTimer);
 if(child&&!child.killed)child.kill('SIGKILL');
 await new Promise(resolve=>server.close(resolve));
 rmSync(root,{recursive:true,force:true});
}
