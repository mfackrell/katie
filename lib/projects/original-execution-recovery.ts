import {rpc} from '@/lib/missions/store';
import {ORIGINAL_TTT_PROJECT,ORIGINAL_TTT_SCOPE} from './management-activation';

export const ORIGINAL_RECOVERY_MISSION='18819669-d4cf-4010-a455-19f5bcbf93cb' as const;
export const ORIGINAL_RECOVERY_ASSIGNMENT='bd8de51d-0195-4c5f-9c88-9dc39e228636' as const;
export type OriginalRecoveryOffer={
 projectId:string;stage:'authorize'|'recovered'|'terminal';
 missionId:string;assignmentId:string;releaseSha:string;
 releaseGeneration:number;deploymentId:string;scopeHash:string;
 priorCutoff:string;cutoff:string|null;authorizationId:string|null;authorizedAt?:string;
 historicalMissions:number;maxMissions:number;remainingMissions?:number;
 authorizedTotalMissions?:number;approvedClaims?:number;approvedRetries?:number;
 tokenAllowance:number;nodeCount:number;currentAttempts:number;
 maxWindowHours?:number;maxClaimsAllowed?:number;
 retryOptions?:number[];spendingTerms?:string;stateHash?:string;
};
// This is strictly a read-only, owner-bound preflight. Never dispatch work.
export async function originalExecutionRecoveryOffer(projectId:string):Promise<OriginalRecoveryOffer>{
 const sha=process.env.VERCEL_GIT_COMMIT_SHA;
 if(projectId!==ORIGINAL_TTT_PROJECT||process.env.VERCEL_ENV!=='production'
  ||!sha||!/^[a-f0-9]{40}$/.test(sha))
  throw Error('Original approved production project and release required');
 const value=await rpc<OriginalRecoveryOffer>('project_org_original_execution_recovery_offer',{
  p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:projectId,p_release:sha
 });
 if(!value||value.projectId!==projectId||value.releaseSha!==sha
  ||!['authorize','recovered','terminal'].includes(value.stage)
  ||value.missionId!==ORIGINAL_RECOVERY_MISSION
  ||value.assignmentId!==ORIGINAL_RECOVERY_ASSIGNMENT
  ||value.scopeHash!==ORIGINAL_TTT_SCOPE
  ||!Number.isSafeInteger(value.releaseGeneration)||value.releaseGeneration<=0
  ||!/^dpl_[A-Za-z0-9]+$/.test(value.deploymentId)
  ||!Number.isFinite(Date.parse(value.priorCutoff))
  ||value.historicalMissions!==84||value.maxMissions!==96
  ||value.tokenAllowance!==600000||value.nodeCount!==13
  ||!Number.isSafeInteger(value.currentAttempts)||value.currentAttempts<0
  ||(value.stage==='authorize'&&(
   value.authorizationId!==null||value.cutoff!==null||value.currentAttempts!==0
   ||typeof value.stateHash!=='string'||!/^[a-f0-9]{64}$/.test(value.stateHash)
   ||value.remainingMissions!==12||value.maxWindowHours!==72
   ||value.maxClaimsAllowed!==26))
  ||(value.stage!=='authorize'&&(
   !value.authorizationId||!/^[0-9a-f-]{36}$/i.test(value.authorizationId)
   ||!value.authorizedAt||!Number.isFinite(Date.parse(value.authorizedAt))
   ||!value.cutoff||!Number.isFinite(Date.parse(value.cutoff))
   ||!Number.isSafeInteger(value.authorizedTotalMissions)
   ||!Number.isSafeInteger(value.approvedClaims)
   ||![0,1].includes(value.approvedRetries??-1))))
  throw Error('Original project signed recovery offer failed independent validation');
 return {...value,priorCutoff:new Date(value.priorCutoff).toISOString(),
  ...(value.cutoff?{cutoff:new Date(value.cutoff).toISOString()}:{})};
}
