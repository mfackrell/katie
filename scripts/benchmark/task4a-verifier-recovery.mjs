import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
// Public immutable evidence IDs; ordinary DB provenance and Git checks still run.
export const TASK4A_VERIFIER_EVIDENCE=Object.freeze({
 runId:'42506385410',jobId:'128809825644',artifactId:'13627283749',
 artifactSha256:'9fc364377baf6fcde8ca415679961569c8b37e29ec548227455ef7fb25e4c40a',
 releaseSha:'61184faf4628d6fd9172cde8f16428e01700468b',
 checkpointSha:'1d51f2fa7f95fec1cb8c777c0525402e05f34f8e',candidateSha:'6270f88765be34811896f1be93373d9b58037f6b',
 sourceTreeSha:'26869fb977fd29b4f96652b9de3d47e0f0e0ffeb',
 approvalId:'1961239b-1722-4901-b671-8e61f4e6af49',grantId:'36d66bdc-c907-49ca-859d-abfed5fc334e',
 taskId:'d0e41ff5-149e-4319-9e65-dcc605fb75da',projectId:'6d1c29f1-b31e-47a5-aabb-cbcf1326f388'
});
const e=TASK4A_VERIFIER_EVIDENCE,root='/repos/mfackrell/katie/actions/';
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const exactRecord=r=>!!r&&createHash('sha256').update(canonical(r)).digest('hex')==='57ecc893edc509864b64efd308e7e105c92ad8039401e845ef7a3de618538f0b';
const deny=()=>{throw Error('TASK4A_FAILED_VERIFIER_EVIDENCE_CHANGED');};
export async function task4aVerifierReader(github){
 const jobs=await github(root+'runs/'+e.runId+'/jobs?per_page=100');
 const matches=jobs.jobs?.filter(j=>String(j.id)===e.jobId),job=matches?.[0];
 if(jobs.total_count>100||matches?.length!==1||String(job.run_id)!==e.runId||job.head_sha!==e.releaseSha||job.run_attempt!==1||job.name!=='build'||job.status!=='completed'||job.conclusion!=='failure'||!job.steps?.some(s=>s.name==='Preserve bounded native execution diagnostics'&&s.conclusion==='success'))deny();
 return async(path,binary=false)=>{
  const result=await github(path,binary);
  if(path===root+'runs/'+e.runId){if(result.head_sha!==e.releaseSha||result.conclusion!=='failure'||result.run_attempt!==1)deny();}
  else if(path===root+'runs/'+e.runId+'/artifacts?per_page=100'){
   const matches=result.artifacts?.filter(a=>a.name==='native-execution-diagnostics');
   if(matches?.length!==1||String(matches[0].id)!==e.artifactId)deny();
  }else if(path===root+'artifacts/'+e.artifactId+'/zip'){
   if(!binary||createHash('sha256').update(result).digest('hex')!==e.artifactSha256)deny();
  }else deny();
  return result;
 };
}
export function validateTask4aVerifierCheckpoint(record,diagnostics){
 if(!exactRecord(record)||record.taskId!==e.taskId||record.projectId!==e.projectId||record.checkpointSha!==e.checkpointSha||record.completedCheckpointSha!==e.candidateSha||record.sourceTreeSha!==e.sourceTreeSha||record.approvalId!==e.approvalId||record.grantId!==e.grantId||String(record.runId)!==e.runId||record.executionEpoch!==4||record.phase!=='review'||record.verification!=='unverified'||record.lastCompleted?.adaptiveRepair?.nextAction!=='verification'||record.lastCompleted?.verification?.pending!==true||record.lastCompleted?.verification?.passed!==false||record.lastCompleted?.review||record.lastCompleted?.initialReview||!Array.isArray(diagnostics?.phases)||diagnostics.phases.length!==0||diagnostics.completed!==false)deny();
 return {artifactId:e.artifactId,artifactSha256:e.artifactSha256,trustedJobId:e.jobId};
}

// Called only after ordinary provenance validation and prepareRecovery.restore().
// This is neither a review attestation nor an execution grant.
export function requireTask4aVerifierRestoration(record,recovery){
 if(!exactRecord(record)||record.checkpointSha!==e.checkpointSha||record.sourceTreeSha!==e.sourceTreeSha||record.lastCompleted?.adaptiveRepair?.nextAction!=='verification'||!isDeepStrictEqual(recovery,{verification:'unverified',phase:record.phase,checkpointSha:record.checkpointSha,completedCheckpointSha:record.completedCheckpointSha,reviewFindings:record.reviewFindings,checkpointEvidence:record.lastCompleted,lastCompleted:record.lastCompleted}))deny();
 return true;
}
