import {rpc} from './store';
import type {Claim} from './types';

export type MissionCapacity={authorized:boolean;remainingTokens:number;callsRemaining:number;routingCallsRemaining:number;reason?:string};
export function missionInputLimit(claim:Claim):number {
 const evidence=claim.mission.project_evidence as {projectProfile?:string}|null;
 return evidence?.projectProfile==='game' && claim.mission.project_kind==='specification' && ['compose','review','revise'].includes(claim.job.role) ? 96000 : 48000;
}
export function fitsMissionEnvelope(instruction:string,input:string,inputLimit=48000){return instruction.length<=48000&&input.length<=inputLimit;}

/** A rejected reservation is NOT a provider call or a failed mission. */
export class MissionAdmissionError extends Error {
 constructor(readonly requestedTokens:number,readonly capacity:MissionCapacity|null){
  super(capacity?.authorized
   ? `Model request requires ${requestedTokens} reserved tokens; ${capacity.remainingTokens} remain in the authorized allowance.`
   : 'Worker no longer authorized or mission allowance exhausted');
  this.name='MissionAdmissionError';
 }
 get canTryAlternative(){return this.capacity?.authorized===true&&this.capacity.callsRemaining>0&&this.capacity.remainingTokens>0;}
}
export async function explainAdmissionDenial(claim:Claim,requestedTokens:number):Promise<never>{
 const value=await rpc<MissionCapacity|null>('mission_call_capacity',{p_id:claim.job.id,p_lease:claim.job.lease});
 const capacity=value&&typeof value==='object'&&typeof value.authorized==='boolean'
  &&Number.isFinite(value.remainingTokens)&&Number.isFinite(value.callsRemaining)?value:null;
 throw new MissionAdmissionError(requestedTokens,capacity);
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
 return Math.min(outputTokens>=16000?180_000:90_000,deadline-now-5000);
}
