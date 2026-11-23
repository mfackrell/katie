import {rpc} from '@/lib/missions/store';
import {ORIGINAL_TTT_PROJECT,ORIGINAL_TTT_SCOPE} from './management-activation';

export const ORIGINAL_RECOVERY_MISSION='18819669-d4cf-4010-a455-19f5bcbf93cb' as const;
export const ORIGINAL_RECOVERY_ASSIGNMENT='bd8de51d-0195-4c5f-9c88-9dc39e228636' as const;
export type OriginalExecutionRecoveryOffer={
 projectId:string;
 stage:'authorize'|'recovered'|'claimed'|'terminal';
 releaseSha:string;releaseGeneration:number;deploymentId:string;
 missionId:string;assignmentId:string;
 priorCutoff:string;priorWindowId:string;
 cutoff?:string;scopeHash:string;
 historicalMissions:number;maxMissions:number;missionCeiling?:number;
 missionCeilingMin?:number;missionCeilingMax?:number;tokenAllowance:number;
 initialAttemptsPerAssignment:number;priorFailureRetryAllowance:number;
 nodeCount:number;currentAttempts:number;authorizationId:string|null;
 authorizedAt?:string;stateHash?:string;
};

// Read-only exact production preflight; it never grants execution or extends
// the deadline. Only the authenticated first-party POST can authorize changes.
export async function originalExecutionRecoveryOffer(projectId:string):Promise<OriginalExecutionRecoveryOffer>{
 const release=process.env.VERCEL_GIT_COMMIT_SHA;
 if(projectId!==ORIGINAL_TTT_PROJECT||process.env.VERCEL_ENV!=='production'
  ||!release||!/^[a-f0-9]{40}$/.test(release))
  throw Error('Original bounded recovery requires exact production source');
 const result=await rpc<OriginalExecutionRecoveryOffer>('project_org_original_recovery_offer',{
  p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:projectId,p_release:release
 });
 if(!result||result.projectId!==projectId||result.releaseSha!==release
  ||result.scopeHash!==ORIGINAL_TTT_SCOPE
  ||result.missionId!==ORIGINAL_RECOVERY_MISSION
  ||result.assignmentId!==ORIGINAL_RECOVERY_ASSIGNMENT
  ||result.historicalMissions!==84||result.maxMissions!==96||result.tokenAllowance!==600000
  ||result.nodeCount!==13||result.initialAttemptsPerAssignment!==1
  ||result.priorFailureRetryAllowance!==0
  ||!Number.isSafeInteger(result.currentAttempts)||result.currentAttempts<0
  ||!Number.isSafeInteger(result.releaseGeneration)||result.releaseGeneration<=0
  ||!/^dpl_[A-Za-z0-9]+$/.test(result.deploymentId)
  ||!Number.isFinite(Date.parse(result.priorCutoff))
  ||!['authorize','recovered','claimed','terminal'].includes(result.stage)
  ||(result.stage==='authorize'&&(result.currentAttempts!==0
    ||result.authorizationId!==null||!/^[a-f0-9]{64}$/.test(result.stateHash??'')
    ||result.missionCeilingMax!==96||result.missionCeilingMin!==84))
  ||(result.stage!=='authorize'&&(!result.authorizationId
    ||!Number.isFinite(Date.parse(result.authorizedAt??''))
    ||!Number.isFinite(Date.parse(result.cutoff??'')))))
  throw Error('Original bounded owner recovery contract or release mismatch');
 return result;
}
