import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {modules} from './helpers/load-project-modules.mjs';
import {TASK4A_SUCCESSOR_ENVELOPE as envelope} from '../scripts/benchmark/task4a-successor-envelope.mjs';
import {createNativeHttpBridge} from '../scripts/benchmark/native-http-bridge.mjs';
test('owner route separates capacity, replacement, paid inference and dispatch; missing proof and replay deny',async()=>{
 const old={...process.env};Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:'e'.repeat(40),KATIE_OWNER_AUTH_USER_ID:'owner'});
 let signed=false,wip=true,qualified=true,dispatches=0;const rows=[],writes=[];
 const events={authority:'task4a_verifier_owner_authorized',replacement:'task4a_verifier_execution_authorized',inference:'task4a_verifier_inference_authorized',dispatch:'task4a_verifier_dispatch_authorized'};
 const db={from:()=>({select:()=>({eq:()=>({in:()=>({returns:async()=>({data:rows,error:null})})})})}),rpc:async(name,args)=>{
 const action=name==='task4a_verifier_proposal'||name==='task4a_verifier_authorize'?'authority':args.p_action;
 if(name.endsWith('proposal'))return {data:{ready:true,digest:action==='authority'?'a'.repeat(64):action==='replacement'?'b'.repeat(64):action==='inference'?'c'.repeat(64):'d'.repeat(64),proposal:{ownerId:'owner',checkpoint:{authenticated:true}}},error:null};
 writes.push(action);rows.push({id:action,event:events[action],data:{ownerId:'owner',result:{approvalId:'child'}}});return {data:{authorized:true,newPaidCalls:0},error:null};
 }};
 const load=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>signed},'@/lib/agents/development':{
 authenticatedTask4aVerifierCheckpoint:async()=>{if(!wip)throw Error('missing WIP');return {checkpoint:{authenticated:true}};},qualifiedOrdinaryDevelopmentRelease:async()=>qualified?'e'.repeat(40):'f'.repeat(40),dispatchTask4aVerifierOnce:async()=>{dispatches++;rows.push({id:'claim',event:'task4a_verifier_execution_claimed',data:{}});throw Error('uncertain acceptance');}}});
 const route=load('@/app/api/projects/task4a-verifier-recovery/route');
 const post=(action,digest)=>route.POST(new Request('https://katie.example/api/projects/task4a-verifier-recovery',{method:'POST',body:JSON.stringify({action,digest,confirm:true})}));
 try{
 assert.equal((await post('authority','a'.repeat(64))).status,403);signed=true;
 assert.equal((await post('dispatch','d'.repeat(64))).status,409);
 wip=false;assert.equal((await post('authority','a'.repeat(64))).status,409);wip=true;
 assert.equal((await post('authority','0'.repeat(64))).status,409);
 qualified=false;assert.equal((await post('authority','a'.repeat(64))).status,409);qualified=true;
 assert.equal((await post('authority','a'.repeat(64))).status,200);assert.equal(dispatches,0);
 assert.equal((await post('dispatch','d'.repeat(64))).status,409);
 assert.equal((await post('replacement','b'.repeat(64))).status,200);assert.equal(dispatches,0);
 assert.equal((await post('dispatch','d'.repeat(64))).status,409);
 assert.equal((await post('inference','c'.repeat(64))).status,200);assert.equal(dispatches,0);
 assert.equal((await post('dispatch','d'.repeat(64))).status,200);assert.equal(dispatches,1);
 assert.equal((await post('dispatch','d'.repeat(64))).status,409);assert.equal(dispatches,1);
 assert.deepEqual(writes,['authority','replacement','inference','dispatch']);
 }finally{for(const k of ['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','KATIE_OWNER_AUTH_USER_ID'])if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}
});
import {readFileSync} from 'node:fs';
import {TASK4A_VERIFIER_EVIDENCE as proof,task4aVerifierReader,validateTask4aVerifierCheckpoint,requireTask4aVerifierRestoration} from '../scripts/benchmark/task4a-verifier-recovery.mjs';
import {executeNativeDevelopmentLifecycle} from '../scripts/benchmark/native-development-lifecycle.mjs';
import {loadRecoveryDiagnostics,createTask4aFailedVerifierCapability} from '../scripts/benchmark/native-wip-recovery.mjs';
const record=JSON.parse(readFileSync('tests/fixtures/task4a-failed-verifier-checkpoint.json','utf8'));
const restored=()=>({verification:'unverified',phase:record.phase,checkpointSha:record.checkpointSha,completedCheckpointSha:record.completedCheckpointSha,reviewFindings:record.reviewFindings,checkpointEvidence:structuredClone(record.lastCompleted),lastCompleted:structuredClone(record.lastCompleted)});
test('exact failed verifier checkpoint remains unreviewed; foreign, tampered and completed evidence rejects',()=>{
 assert.equal(validateTask4aVerifierCheckpoint(record,{completed:false,phases:[]}).artifactId,proof.artifactId);
 for(const patch of [{checkpointSha:'0'.repeat(40)},{sourceTreeSha:'0'.repeat(40)},{approvalId:'foreign'},{grantId:'foreign'},{projectId:'foreign'},{phase:'implementation'},{executionEpoch:3},{lastCompleted:{...record.lastCompleted,review:{verdict:'pass'}}}])assert.throws(()=>validateTask4aVerifierCheckpoint({...record,...patch},{completed:false,phases:[]}),/EVIDENCE_CHANGED/);
 for(const d of [{completed:true,phases:[]},{completed:false,phases:[{phase:'implementation'}]},{}])assert.throws(()=>validateTask4aVerifierCheckpoint(record,d),/EVIDENCE_CHANGED/);
 assert.throws(()=>validateTask4aVerifierCheckpoint(null,{}),/EVIDENCE_CHANGED/);
 assert.equal(requireTask4aVerifierRestoration(record,restored()),true);
 assert.throws(()=>requireTask4aVerifierRestoration(record,{...restored(),phase:'implementation'}),/EVIDENCE_CHANGED/);
});
test('trusted job, run, artifact ID and exact archive hash are mandatory',async()=>{
 const root='/repos/mfackrell/katie/actions/';
 let job={id:Number(proof.jobId),run_id:Number(proof.runId),head_sha:proof.releaseSha,run_attempt:1,name:'build',status:'completed',conclusion:'failure',steps:[{name:'Preserve bounded native execution diagnostics',conclusion:'success'}]};
 let tampered=false;
 const archive=Buffer.from(readFileSync('tests/fixtures/task4a-failed-verifier-artifact.base64','utf8').trim(),'base64');
 const read=async path=>path.includes('/jobs?')?{total_count:1,jobs:[job]}:path.endsWith('/zip')?(tampered?Buffer.from('tampered'):archive):path.includes('/artifacts?')?{artifacts:[{id:Number(proof.artifactId),name:'native-execution-diagnostics',expired:false,size_in_bytes:archive.length,workflow_run:{id:Number(proof.runId),head_sha:proof.releaseSha}}]}:{id:Number(proof.runId),head_sha:proof.releaseSha,run_attempt:1,conclusion:'failure',status:'completed',event:'workflow_dispatch',path:'.github/workflows/autonomous-development.yml',head_branch:'main',repository:{full_name:'mfackrell/katie'},head_repository:{full_name:'mfackrell/katie'}};
 const checked=await task4aVerifierReader(read);
 await checked(root+'runs/'+proof.runId);await checked(root+'runs/'+proof.runId+'/artifacts?per_page=100');
 const loaded=await loadRecoveryDiagnostics({task:{id:proof.taskId,external:{issueNumber:969,receipt:{run_id:Number(proof.runId),issue_number:969,repository:'mfackrell/katie',outcome:'BLOCKED'}}},repository:'mfackrell/katie',github:checked});
 assert.deepEqual(loaded.record,record);assert.equal(validateTask4aVerifierCheckpoint(loaded.record,loaded.diagnostics).artifactSha256,proof.artifactSha256);
 tampered=true;
 await assert.rejects(()=>checked(root+'artifacts/'+proof.artifactId+'/zip',true),/EVIDENCE_CHANGED/);
 await assert.rejects(()=>checked(root+'artifacts/1/zip',true),/EVIDENCE_CHANGED/);
 for(const patch of [{head_sha:'0'.repeat(40)},{conclusion:'success'},{run_attempt:2},{steps:[]},{id:1},{run_id:1}]){
 const original=job;job={...job,...patch};await assert.rejects(()=>task4aVerifierReader(read),/EVIDENCE_CHANGED/);job=original;
 }
});
test('restored pending verification runs before both reviews with no implementation request',async()=>{
 const recovery=restored(),events=[];
 const result=await executeNativeDevelopmentLifecycle({recovery,verificationFirstCapability:createTask4aFailedVerifierCapability(record,recovery),
 runPhase:async phase=>{events.push(phase);assert.ok(['review','final-review'].includes(phase));return {verdict:'pass',findings:'Independent review passed',reviewedHeadSha:proof.candidateSha};},
 commitCandidate:async()=>assert.fail('Existing completed candidate must be reused'),
 verifyCandidate:async head=>{assert.equal(head,proof.candidateSha);events.push('verify');return {passed:true,detail:'Deterministic verification passed'};}});
 assert.deepEqual(events,['verify','review','final-review']);assert.equal(result.candidateHead,proof.candidateSha);assert.equal(result.repairPerformed,false);
});
test('failed verification or missing independent review cannot complete',async()=>{
 for(const failure of ['verification','review']){
 const recovery=restored();let phases=0,completed=false;
 await assert.rejects(async()=>{await executeNativeDevelopmentLifecycle({recovery,verificationFirstCapability:createTask4aFailedVerifierCapability(record,recovery),
 verifyCandidate:async()=>({passed:failure!=='verification',kind:'infrastructure',detail:'fixture'}),
 runPhase:async()=>{phases++;return null;},commitCandidate:async()=>assert.fail('No implementation')});completed=true;},/VERIFICATION_FAILED|REVIEW_INVALID/);
 assert.equal(completed,false);assert.equal(phases,failure==='verification'?0:1);
 }
});
