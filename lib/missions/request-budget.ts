import {rpc} from './store';
import {measureDeliverable} from './review-length';
import {readOnlyRepositoryObjective,type Claim} from './types';
import {SPECIFICATION_STAGE_TOKENS} from '@/lib/projects/specification-recovery';

export type MissionCapacity={authorized:boolean;remainingTokens:number;callsRemaining:number;routingCallsRemaining:number;reason?:string};
export function missionInputLimit(claim:Claim):number {
 const evidence=claim.mission.project_evidence as {projectProfile?:string;savedSpecificationCheckpoint?:unknown;specificationRecovery?:unknown}|null;
 const finalStage=['compose','review','revise'].includes(claim.job.role);
 // Immutable source excerpts, a full candidate and independently scoped live
 // traces must fit together. This changes input capacity, not token authority:
 // native counting and the existing fenced reservation still admit each call.
 const repositoryAudit=Boolean(claim.mission.repository_id)&&readOnlyRepositoryObjective(claim.mission.objective);
 const operationalAudit=/\baudit\b/i.test(claim.mission.objective)&&/\b(?:workflow|operational|assignment histor|execution record)/i.test(claim.mission.objective);
 const recoveredSpecificationStage=['review','revise'].includes(claim.job.role)&&claim.mission.project_kind==='specification'&&Boolean(evidence?.savedSpecificationCheckpoint&&evidence?.specificationRecovery);
 return finalStage&&((evidence?.projectProfile==='game'&&claim.mission.project_kind==='specification')||recoveredSpecificationStage||repositoryAudit||operationalAudit)?96000:48000;
}
/** Size the first audited deliverable for its full evidence-backed scope. A
 * known short word cap stays small; an unbounded audit must not buy a predictably
 * truncated draft before receiving the already-supported 12K output envelope. */
export function missionOutputLimit(claim:Claim,input:string):number {
 if(claim.job.role==='revise'&&typeof claim.job.payload?.revisionPatchBaseHash==='string')return 3000;
 if(['compose','revise'].includes(claim.job.role)){
  if(claim.mission.project_kind==='specification'&&(claim.mission.project_evidence as {projectProfile?:string}|null)?.projectProfile==='game')return 16000;
  // Recovery needs room for retained input findings, not a larger deliverable.
  const evidence=claim.mission.project_evidence as {savedSpecificationCheckpoint?:unknown;specificationRecovery?:unknown}|null;
  if(claim.mission.project_kind==='specification'&&evidence?.savedSpecificationCheckpoint&&evidence?.specificationRecovery)return 6000;
  const limit=measureDeliverable(claim.mission.objective,'').wordLimit;
  return missionInputLimit(claim)>48000&&(limit===null||limit>1200)?12000:6000;
 }
 if(claim.job.role==='review'){
  // The existing fixed project phase contract has six required checks. Keep
  // those checks complete without reserving a second long-form report.
  if(claim.mission.project_kind==='specification')return 5000;
  if(!input.startsWith('Independent assessment:\n'))return 5000;
  const limit=measureDeliverable(claim.mission.objective,'').wordLimit;
  // Short artifacts need a full comparison, not another report. Keep all
  // acceptance checks while reserving a proportional structured verdict.
  return limit!==null&&limit<=1200?6000:10000;
 }
 return 3000;
}
export function fitsMissionEnvelope(instruction:string,input:string,inputLimit=48000){return instruction.length<=48000&&input.length<=inputLimit;}

/** A rejected reservation is NOT a provider call or a failed mission. */
export class MissionAdmissionError extends Error {
 constructor(readonly requestedTokens:number,readonly capacity:MissionCapacity|null){
  super(capacity?.reason??(capacity?.authorized
   ? `Model request requires ${requestedTokens} reserved tokens; ${capacity.remainingTokens} remain in the authorized allowance.`
   : 'Worker no longer authorized or mission allowance exhausted'));
  this.name='MissionAdmissionError';
 }
 get canTryAlternative(){return this.capacity?.authorized===true&&this.capacity.callsRemaining>0&&this.capacity.remainingTokens>0;}
}
// A schema retry may reserve less output, never more authority. Keep a useful
// minimum and protect every later stage exactly as on the first attempt.
export function specificationRoutingOutputFloor(claim:Claim,input:string){
 return schemaRetry(claim)?6000:missionOutputLimit(claim,input);
}
function schemaRetry(claim:Claim){
 return claim.mission.project_kind==='specification'&&claim.job.role==='compose'&&
  (claim.mission.project_evidence as {specificationBudget?:{version?:number};projectProfile?:string}|null)?.specificationBudget?.version===1&&
  (claim.mission.project_evidence as {projectProfile?:string}|null)?.projectProfile==='game'&&
  typeof claim.job.result?.rejectedSpecification==='string';
}
export async function specificationRetryOutputLimit(claim:Claim,inputTokens:number,desired:number){
 if(!schemaRetry(claim))return desired;
 const future=SPECIFICATION_STAGE_TOKENS.review+SPECIFICATION_STAGE_TOKENS.revision+SPECIFICATION_STAGE_TOKENS.review_again;
 const capacity=await rpc<(MissionCapacity&{stageRemainingTokens:number})|null>('specification_call_capacity',{p_id:claim.job.id,p_lease:claim.job.lease});
 const available=capacity?.authorized?Math.min(capacity.stageRemainingTokens,capacity.remainingTokens-future)-inputTokens:0;
 if(!Number.isSafeInteger(available)||available<6000)throw new MissionAdmissionError(inputTokens+6000+future,capacity);
 return Math.min(desired,available);
}
export async function explainAdmissionDenial(claim:Claim,requestedTokens:number):Promise<never>{
 const value=await rpc<MissionCapacity|null>('mission_call_capacity',{p_id:claim.job.id,p_lease:claim.job.lease});
 const capacity=value&&typeof value==='object'&&typeof value.authorized==='boolean'
  &&Number.isFinite(value.remainingTokens)&&Number.isFinite(value.callsRemaining)?value:null;
 throw new MissionAdmissionError(requestedTokens,capacity);
}
/** A paid draft/retry cannot consume the allowance for its required reviewers.
 * The DB still atomically reserves each native-counted request and aggregate cost. */
export async function assertSpecificationStageCapacity(claim:Claim,requestedTokens:number,executionFloor=0){
 const budget=(claim.mission.project_evidence as {specificationBudget?:{version?:number}}|null)?.specificationBudget;
 if(claim.mission.project_kind!=='specification'||budget?.version!==1)return;
 const stage=claim.job.role==='revise'?'revision':claim.job.job_key==='review_again'?'review_again':claim.job.role;
 if(!['compose','review','revision','review_again'].includes(stage))throw Error('Specification mission has an unbudgeted inference stage');
 const cap=SPECIFICATION_STAGE_TOKENS[stage as 'compose'|'review'|'revision'|'review_again'];
 const future=stage==='compose'?SPECIFICATION_STAGE_TOKENS.review+SPECIFICATION_STAGE_TOKENS.revision+SPECIFICATION_STAGE_TOKENS.review_again
  :stage==='review'?SPECIFICATION_STAGE_TOKENS.revision+SPECIFICATION_STAGE_TOKENS.review_again
  :stage==='revision'?SPECIFICATION_STAGE_TOKENS.review_again:0;
 const capacity=await rpc<(MissionCapacity&{stageRemainingTokens:number})|null>('specification_call_capacity',{p_id:claim.job.id,p_lease:claim.job.lease});
 if(requestedTokens+executionFloor>cap||!capacity?.authorized||!Number.isFinite(capacity.stageRemainingTokens)||capacity.stageRemainingTokens<requestedTokens+executionFloor||capacity.remainingTokens<requestedTokens+executionFloor+future)
  throw new MissionAdmissionError(requestedTokens+executionFloor+future,capacity?{...capacity,reason:`Specification ${stage} request needs ${requestedTokens} tokens plus ${executionFloor} execution-output headroom; stage allowance remaining ${capacity.stageRemainingTokens}, mission allowance remaining ${capacity.remainingTokens}, protected future stages ${future}. No provider call was authorized.`}:capacity);
}
/** All retries within one worker invocation share its original wall-clock window.
 * Reserve two minutes for persistence/cleanup before the six-minute worker lease. */
export function missionExecutionDeadline(claim:Claim,now=Date.now()){
 const lease=Date.parse(claim.job.lease_until);
 const mission=Date.parse(claim.mission.deadline??'');
 return Math.min(now+240_000,Number.isFinite(lease)?lease-120_000:Infinity,Number.isFinite(mission)?mission-5000:Infinity);
}
export function missionAttemptTimeout(deadline:number,outputTokens:number,now=Date.now()){
 // Long structured drafts are not given the same timeout as a short classifier.
 // This does NOT extend the caller's overall runtime, lease, or project deadline.
 return Math.min(outputTokens>=12000?180_000:90_000,deadline-now-5000);
}
