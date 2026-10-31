// Trusted host only. Recovery reads historical evidence; it never grants authority,
// reconciles charges, replays a request, or treats WIP as reviewed source.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,openSync,closeSync,mkdirSync,lstatSync,fstatSync,ftruncateSync,fchmodSync,writeSync,unlinkSync,constants} from 'node:fs';
import {join} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
import {protectedGitConfig} from './native-trust-boundary.mjs';

const fail=reason=>{throw Error('NATIVE_WIP_RECOVERY_DENIED: '+reason);};
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const same=(actual,expected,reason)=>{if(!isDeepStrictEqual(actual,expected))fail(reason);};
const gitAt=workspace=>(...args)=>execFileSync('git',[...protectedGitConfig,...args],{
 cwd:workspace,encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024,stdio:['pipe','pipe','pipe']}).trim();

function materialize(workspace,{path,content,mode}){
 const descriptors=[];
 try{
  let fd=openSync(workspace,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);descriptors.push(fd);
  const parts=path.split('/'),leaf=parts.pop();
  for(const part of parts){
   const next=`/proc/self/fd/${fd}/${part}`;
   try{mkdirSync(next);}catch(error){if(error.code!=='EEXIST')throw error;}
   fd=openSync(next,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);descriptors.push(fd);
  }
  const target=`/proc/self/fd/${fd}/${leaf}`;
  let existing;try{existing=lstatSync(target);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(existing&&(!existing.isFile()||existing.nlink!==1))fail('unsafe existing recovery path');
  if(content===null){if(existing)unlinkSync(target);return;}
  fd=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);descriptors.push(fd);
  const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)fail('unsafe recovery destination');
  ftruncateSync(fd,0);let offset=0;while(offset<content.length)offset+=writeSync(fd,content,offset,content.length-offset);
  fchmodSync(fd,mode==='100755'?0o755:0o644);
 }finally{for(const fd of descriptors.reverse())closeSync(fd);}
}

// No filesystem extraction, arbitrary artifact path, or unbounded decompression.
export function readRecoveryArtifact(zip){
 if(!Buffer.isBuffer(zip)||zip.length>8*1024*1024)fail('diagnostic archive exceeds bounds');
 const name='native-metered-review.json.diagnostics.json';let found;
 for(let p=Math.max(0,zip.length-65557);p<=zip.length-22;p++){
  if(zip.readUInt32LE(p)!==0x06054b50||p+22+zip.readUInt16LE(p+20)!==zip.length)continue;
  let offset=zip.readUInt32LE(p+16);const count=zip.readUInt16LE(p+10);
  if(count!==1)fail('ambiguous diagnostic archive');
  if(offset+46>zip.length||zip.readUInt32LE(offset)!==0x02014b50)fail('invalid diagnostic archive');
  const method=zip.readUInt16LE(offset+10),size=zip.readUInt32LE(offset+20),unpacked=zip.readUInt32LE(offset+24);
  const length=zip.readUInt16LE(offset+28),local=zip.readUInt32LE(offset+42);
  if(zip.subarray(offset+46,offset+46+length).toString()!==name||size>8*1024*1024||unpacked>8*1024*1024||local+30>zip.length||zip.readUInt32LE(local)!==0x04034b50)fail('invalid diagnostic entry');
  const start=local+30+zip.readUInt16LE(local+26)+zip.readUInt16LE(local+28);
  if(start+size>zip.length)fail('truncated diagnostic archive');
  const compressed=zip.subarray(start,start+size);
  const bytes=method===0?compressed:method===8?inflateRawSync(compressed,{maxOutputLength:8*1024*1024}):null;
  if(!bytes||bytes.length!==unpacked||found)fail('invalid diagnostic compression');
  found=JSON.parse(bytes.toString('utf8'));
 }
 if(!found)fail('diagnostics unavailable; retain checkpoint and recover trusted run evidence');
 return found;
}

export function githubRecoveryReader(repository){
 if(repository!=='mfackrell/katie')fail('repository mismatch');
 return (path,binary=false)=>{
  if(!path.startsWith(`/repos/${repository}/actions/`))fail('invalid evidence endpoint');
  const bytes=execFileSync('gh',['api',path],{timeout:30000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
  return binary?bytes:JSON.parse(bytes.toString('utf8'));
 };
}

// The saved service-owned receipt selects a completed, trusted workflow run.
// Unsigned Git tags alone are never an authenticity anchor.
export async function loadRecoveryDiagnostics({task,repository,github}){
 const receipt=task.external?.receipt,runId=String(receipt?.run_id??'');
 if(!/^[1-9][0-9]*$/.test(runId)||receipt.repository!==repository||receipt.outcome!=='BLOCKED'||
    !Number.isSafeInteger(receipt.issue_number)||receipt.issue_number!==Number(task.external.issueNumber))fail('failed same-task run receipt required');
 const run=await github(`/repos/${repository}/actions/runs/${runId}`);
 if(String(run.id)!==runId||run.status!=='completed'||!['failure','cancelled','timed_out'].includes(run.conclusion)||
    !['workflow_dispatch','issues'].includes(run.event)||run.path!=='.github/workflows/autonomous-development.yml'||run.head_branch!=='main'||
    run.repository?.full_name!==repository||run.head_repository?.full_name!==repository||!sha(run.head_sha)||!Number.isSafeInteger(run.run_attempt)||run.run_attempt<1)fail('untrusted recovery workflow run');
 const list=await github(`/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`);
 if(!Array.isArray(list.artifacts)||list.total_count>100)fail('ambiguous recovery artifacts');
 const matches=list.artifacts.filter(a=>a.name==='native-execution-diagnostics');
 if(matches.length!==1||matches[0].expired||!Number.isSafeInteger(matches[0].id)||matches[0].size_in_bytes>8*1024*1024||
    String(matches[0].workflow_run?.id)!==runId||matches[0].workflow_run?.head_sha!==run.head_sha)fail('missing, expired or ambiguous trusted diagnostics');
 const diagnostics=readRecoveryArtifact(await github(`/repos/${repository}/actions/artifacts/${matches[0].id}/zip`,true));
 if(diagnostics.taskId!==task.id||String(diagnostics.runId)!==runId||diagnostics.completed!==false||!diagnostics.wipCheckpoint)fail('diagnostics do not identify unfinished same-task WIP');
 const record=diagnostics.wipCheckpoint;
 if(record.runId!==runId||record.runAttempt!==String(run.run_attempt))fail('checkpoint run attempt mismatch');
 return {record,diagnostics};
}

export function recoveryCompletedEvidence(record,diagnostics){
 const last=structuredClone(record.lastCompleted);
 if(record.phase!=='repair'||last?.review&&last?.verification)return last;
 // Original PR #902 checkpoints retain this evidence in diagnostics rather than
 // lastCompleted. Authenticate that artifact first; never rewrite Git metadata.
 const reviews=diagnostics?.phases?.filter(p=>p.phase==='review'&&p.outcome?.code===0&&p.outcome.signal===null&&p.terminalEvent==='turn.completed')??[];
 const verifications=diagnostics?.verification?.filter(v=>v.head===record.completedCheckpointSha)??[];
 if(last?.phase!=='review'||reviews.length!==1||verifications.length!==1||
    !/^(PASS|CHANGES_REQUESTED)(?:\s|$)/.test(reviews[0].finalMessage??'')||
    !record.reviewFindings?.startsWith(reviews[0].finalMessage)||
    !diagnostics.phases.slice(diagnostics.phases.indexOf(reviews[0])+1).some(p=>p.phase==='repair'))fail('legacy completed review evidence unavailable or ambiguous');
 const delimiter=' Trusted deterministic verification: ',at=record.reviewFindings.indexOf(delimiter);
 if(at<1)fail('legacy full reviewer findings unavailable');
 return {...last,review:{phase:'review',verdict:/^PASS(?:\s|$)/.test(reviews[0].finalMessage)?'pass':'changes_requested',findings:record.reviewFindings.slice(0,at)},verification:verifications[0]};
}

export async function validateRecoveryRecords({record,task,context,project,trialId,accountId,readOne,completedEvidence=record.lastCompleted}){
 if(record.version!==1||record.kind!=='native-unverified-wip'||record.verification!=='unverified'||
    !['implementation','repair'].includes(record.phase)||!sha(record.checkpointSha)||!sha(record.completedCheckpointSha)||!sha(record.sourceTreeSha))fail('invalid WIP identity');
 for(const [value,expected,label] of [[record.taskId,task.id,'task'],[record.projectId,project.id,'project'],
  [record.trialId,trialId,'trial'],[record.originalBaselineSha,context.baselineSha,'baseline'],[record.baseSha,context.baseSha,'base'],
  [record.approvedScopeHash,project.approved_hash,'scope hash'],[record.approvedScope,{hash:project.approved_hash,allowedPaths:context.allowedPaths,contractHash:context.contractHash},'scope and contract']])same(value,expected,label+' mismatch');
 const assignment=await readOne('mission_assignments','id',task.id);
 const run=await readOne('project_runs','mission_id',assignment.mission_id);
 const binding=run.binding;
 if(!binding||project.approved_hash!==project.approval_hash||project.active_mission_id!==assignment.mission_id||run.project_id!==project.id)fail('authoritative project binding unavailable');
 for(const key of ['projectId','baselineSha','baseSha','allowedPaths','contractHash'])same(context[key],binding[key],'authoritative '+key+' mismatch');
 same(binding.scopeHash,project.approved_hash,'authoritative scope hash mismatch');
 const approval=await readOne('benchmark_native_spending_approvals','id',record.approvalId);
 const grant=await readOne('benchmark_execution_grants','id',record.grantId);
 if(approval.task_id!==task.id||approval.project_id!==project.id||approval.trial_id!==trialId||approval.account_id!==accountId||!approval.consumed_at||
    grant.mission_assignment_id!==task.id||grant.project_id!==project.id||grant.trial_id!==trialId||grant.account_id!==accountId||
    grant.execution_epoch!==record.executionEpoch||grant.owner_actor_id!==approval.actor_id||grant.repository!==task.repository_full_name||
    grant.protocol_digest!==approval.protocol_digest||grant.model!==approval.model)fail('historical grant binding mismatch');
 const last=completedEvidence;
 if(!last||last.checkpointSha!==record.completedCheckpointSha)fail('completed checkpoint evidence missing');
 if(last.modelCall){
  const call=await readOne('benchmark_budget_calls','id',last.modelCall.operationId);
  const missionCall=await readOne('mission_calls','id',last.modelCall.requestKey);
  // A new host can be interrupted before its first paid admission. In that case
  // the last completed request still belongs to a prior, unchanged grant.
  const callGrant=missionCall.lease===grant.id?grant:await readOne('benchmark_execution_grants','id',missionCall.lease);
  if(call.account_id!==accountId||call.request_key!==last.modelCall.requestKey||call.legacy_mission_call_id!==missionCall.id||
     call.actual_tokens!==last.modelCall.actualTokens||call.state!==last.modelCall.settlement||!['settled','overrun'].includes(call.state)||
     missionCall.job_id!==task.id||callGrant.mission_assignment_id!==task.id||callGrant.project_id!==project.id||
     callGrant.account_id!==accountId||callGrant.trial_id!==trialId||callGrant.owner_actor_id!==grant.owner_actor_id||
     callGrant.repository!==grant.repository||callGrant.model!==grant.model||!Number.isSafeInteger(callGrant.execution_epoch)||
     callGrant.execution_epoch>grant.execution_epoch)fail('historical model-call evidence mismatch');
 }else if(record.phase==='repair')fail('repair call evidence missing');
 if(record.phase==='repair'){
  if(last.phase!=='review'||!last.review||last.review.phase!=='review'||!['pass','changes_requested'].includes(last.review.verdict)||
     typeof last.review.findings!=='string'||!last.review.findings.trim()||typeof record.reviewFindings!=='string'||!record.reviewFindings.trim()||
     !last.verification||last.verification.head!==record.completedCheckpointSha||typeof last.verification.passed!=='boolean'||
     (last.review.verdict==='pass'&&last.verification.passed))fail('completed review and verification evidence required for repair');
 }
 return record;
}

export function recoveryRefs(workspace,taskId){
 if(!/^[a-f0-9-]{36}$/.test(taskId))fail('invalid task identity');
 const output=gitAt(workspace)('ls-remote','--refs','origin',`refs/tags/katie-wip/${taskId}/*`);
 const refs=output?output.split('\n').map(line=>{const [checkpointSha,ref]=line.split(/\s+/);return {checkpointSha,ref};}):[];
 if(refs.length>1000)fail('checkpoint selection exceeds bounds');
 return refs;
}

// Validate both complete trees in a private index before changing HEAD or files.
// Read-only history/ref fetching is harmless on rejection. Only a fresh runner
// with no source edits is eligible; never overwrite another recovery attempt.
export function prepareRecovery({workspace,tempRoot,toolsRoot,requestFile,context,record,refs,completedEvidence=record.lastCompleted}){
 record=structuredClone(record);completedEvidence=structuredClone(completedEvidence);
 const git=gitAt(workspace),prefix=`refs/tags/katie-wip/${record.taskId}/`;
 const entries=refs.map(entry=>{
  const match=entry.ref.startsWith(prefix)&&entry.ref.slice(prefix.length).match(/^([1-9][0-9]*)-([1-9][0-9]*)\/([1-9][0-9]*)$/);
  if(!match||!sha(entry.checkpointSha))fail('invalid checkpoint ref');
  return {...entry,run:BigInt(match[1]),attempt:BigInt(match[2]),sequence:BigInt(match[3])};
 });
 entries.sort((a,b)=>a.run!==b.run?(a.run>b.run?-1:1):a.attempt!==b.attempt?(a.attempt>b.attempt?-1:1):a.sequence>b.sequence?-1:1);
 if(!entries.length||entries[0].ref!==record.ref||entries[0].checkpointSha!==record.checkpointSha)fail('latest remote checkpoint lacks matching trusted evidence');
 if(git('rev-parse','HEAD')!==context.baseSha||git('diff','--name-only')||git('diff','--cached','--name-only')||
    git('ls-files','--others','--exclude-standard','-z').split('\0').filter(p=>p&&p!=='AGENT_REQUEST.md').length)fail('recovery requires a clean original runner baseline');
 git('fetch','--no-tags','origin',record.ref);
 if(git('rev-parse','FETCH_HEAD')!==record.checkpointSha)fail('remote checkpoint changed during recovery');
 const raw=git('show','-s','--format=%B',record.checkpointSha);
 if(Buffer.byteLength(raw)>24000)fail('checkpoint metadata exceeds bounds');
 const {checkpointSha:_,ref:__,...metadata}=record;
 same(JSON.parse(raw),metadata,'checkpoint metadata was forged or altered');
 same(git('rev-parse',record.checkpointSha+'^{tree}'),record.sourceTreeSha,'checkpoint tree mismatch');
 const parents=git('show','-s','--format=%P',record.checkpointSha).split(' ');
 if(parents.length>2||parents[0]!==record.completedCheckpointSha)fail('completed checkpoint ancestry mismatch');
 git('merge-base','--is-ancestor',context.baseSha,record.completedCheckpointSha);
 git('merge-base','--is-ancestor',context.baselineSha,record.completedCheckpointSha);
 const scratch=mkdtempSync(join(tempRoot,'recovery-index-'));
 try{
  const env={...process.env,GIT_INDEX_FILE:join(scratch,'index')};
  for(const commit of [...new Set([record.completedCheckpointSha,record.checkpointSha])]){
   execFileSync('git',[...protectedGitConfig,'read-tree',commit],{cwd:workspace,env,timeout:20000,stdio:'pipe'});
   // An interrupted initial implementation may have no completed source yet.
   if(commit===context.baseSha&&record.phase==='implementation')continue;
   for(const tool of ['project-scope.mjs','recovery-scope.mjs'])execFileSync(process.execPath,[join(toolsRoot,tool),requestFile],{cwd:workspace,env,timeout:20000,stdio:'pipe'});
  }
 }catch{fail('checkpoint fails unchanged cumulative scope gates');}
 finally{rmSync(scratch,{recursive:true,force:true});}
 // Materialize raw Git blobs, never checkout/smudge/process filters or working
 // tree encodings selected by unreviewed attributes. This also restores files
 // in the completed implementation that the interrupted repair did not touch.
 const paths=git('diff','--no-ext-diff','--no-renames','--name-only','-z',context.baseSha,record.checkpointSha).split('\0').filter(Boolean);
 if(paths.length>200)fail('recovery source count exceeds bounds');
 let bytes=0;
 const files=paths.map(path=>{
  if(/[\x00-\x1f\x7f\\]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..')||
     !context.allowedPaths.some(p=>path===p||p.endsWith('/')&&path.startsWith(p)))fail('unsafe recovery source path');
  const entry=git('ls-tree','-z',record.checkpointSha,'--',path).split('\t')[0];
  if(!entry)return {path,content:null};
  const [mode,type,blob]=entry.split(' ');
  if(!['100644','100755'].includes(mode)||type!=='blob'||!sha(blob))fail('unsafe recovery source type');
  const content=execFileSync('git',[...protectedGitConfig,'cat-file','blob',blob],{cwd:workspace,timeout:20000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});
  bytes+=content.length;if(bytes>4*1024*1024)fail('recovery source bytes exceed bounds');
  return {path,content,mode};
 });
 return Object.freeze({record:structuredClone(record),restore(){
  // No provider session or Git commit is created. The trusted completed commit
  // remains HEAD; unfinished source stays unstaged and explicitly unverified.
  if(git('rev-parse','HEAD')!==context.baseSha||git('diff','--name-only')||git('diff','--cached','--name-only')||
     git('ls-files','--others','--exclude-standard','-z').split('\0').filter(p=>p&&p!=='AGENT_REQUEST.md').length)fail('runner changed after recovery validation');
  for(const file of files)materialize(workspace,file);
  // Index-only read-tree and compare-and-swap HEAD preserve candidate ancestry
  // without executing any checkout helpers. WIP is never promoted to HEAD.
  git('read-tree',record.completedCheckpointSha);
  git('update-ref','HEAD',record.completedCheckpointSha,context.baseSha);
  return {verification:'unverified',phase:record.phase,checkpointSha:record.checkpointSha,completedCheckpointSha:record.completedCheckpointSha,
   reviewFindings:record.reviewFindings,lastCompleted:structuredClone(completedEvidence)};
 }});
}
