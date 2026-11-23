import {rpc} from '@/lib/missions/store';
import {ORIGINAL_TTT_PROJECT,ORIGINAL_TTT_SCOPE} from './management-activation';

export const ORIGINAL_RECOVERY_MISSION='18819669-d4cf-4010-a455-19f5bcbf93cb' as const;
export const ORIGINAL_RECOVERY_ASSIGNMENT='bd8de51d-0195-4c5f-9c88-9dc39e228636' as const;

export type OriginalBoundedRecoveryOffer={
 projectId:string;stage:'authorize'|'authorized';releaseSha:string;
 releaseGeneration:number;deploymentId:string;scopeHash:string;
 priorCutoff:string;cutoff:string|null;stateHash?:string;
 authorizationId:string|null;authorizedAt?:string;
 historicalMissions:number;maxMissions:number;tokenAllowance:number;
 usedTokens?:number;remainingTokens?:number;remainingMissions?:number;
 additionalPaidRetries:number;activeMissionId:string;assignmentId:string;
 nodeCount:number;maxWindowHours?:number;
};

export async function originalBoundedRecoveryOffer(projectId:string):Promise<OriginalBoundedRecoveryOffer>{
 const sha=process.env.VERCEL_GIT_COMMIT_SHA;
 if(projectId!==ORIGINAL_TTT_PROJECT||process.env.VERCEL_ENV!=='production'
  ||!sha||!/^[a-f0-9]{40}$/.test(sha))
  throw Error('Exact original production owner recovery required');
 const offer=await rpc<OriginalBoundedRecoveryOffer>('project_org_bounded_recovery_offer',{
  p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:projectId,p_release:sha
 });
 if(!offer||offer.projectId!==projectId||offer.releaseSha!==sha
  ||!['authorize','authorized'].includes(offer.stage)
  ||offer.scopeHash!==ORIGINAL_TTT_SCOPE
  ||offer.activeMissionId!==ORIGINAL_RECOVERY_MISSION
  ||offer.assignmentId!==ORIGINAL_RECOVERY_ASSIGNMENT
  ||!Number.isSafeInteger(offer.releaseGeneration)||offer.releaseGeneration<=0
  ||!/^dpl_[A-Za-z0-9]+$/.test(offer.deploymentId)
  ||!Number.isFinite(Date.parse(offer.priorCutoff))
  ||offer.historicalMissions!==84||offer.maxMissions!==96
  ||offer.tokenAllowance!==600000||offer.additionalPaidRetries!==0||offer.nodeCount!==13
  ||(offer.stage==='authorize'&&(
   offer.cutoff!==null||offer.authorizationId!==null
   ||offer.maxWindowHours!==72||offer.remainingMissions!==12
   ||typeof offer.usedTokens!=='number'||!Number.isSafeInteger(offer.usedTokens)||offer.usedTokens<0
   ||typeof offer.remainingTokens!=='number'||!Number.isSafeInteger(offer.remainingTokens)
   ||offer.usedTokens+offer.remainingTokens!==600000
   ||!/^[a-f0-9]{64}$/.test(offer.stateHash??'')))
  ||(offer.stage==='authorized'&&(
   !offer.cutoff||!Number.isFinite(Date.parse(offer.cutoff))
   ||!/^[0-9a-f-]{36}$/i.test(offer.authorizationId??'')
   ||!offer.authorizedAt||!Number.isFinite(Date.parse(offer.authorizedAt)))))
  throw Error('Original recovery authorization contract or release mismatch');
 return {...offer,priorCutoff:new Date(offer.priorCutoff).toISOString(),
  cutoff:offer.cutoff?new Date(offer.cutoff).toISOString():null};
}
