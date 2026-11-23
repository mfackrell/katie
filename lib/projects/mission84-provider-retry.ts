import {rpc} from '@/lib/missions/store';
import {ORIGINAL_TTT_PROJECT,ORIGINAL_TTT_SCOPE} from './management-activation';

export const M84_PROVIDER_MISSION='18819669-d4cf-4010-a455-19f5bcbf93cb' as const;
export const M84_PROVIDER_ASSIGNMENT='bd8de51d-0195-4c5f-9c88-9dc39e228636' as const;
export type Mission84ProviderRetryOffer={
 projectId:string;stage:'authorize'|'authorized';releaseSha:string;
 releaseGeneration:number;deploymentId:string;scopeHash:string;
 cutoff:string;stateHash?:string;authorizationId:string|null;
 missionId:string;assignmentId:string;originalRequestId?:string;
 originalAttempts:number;originalCalls?:number;historicalMissions:number;
 maxMissions:number;tokenAllowance:number;nodeCount:number;newPaidAttempts:number;
};
export async function mission84ProviderRetryOffer(projectId:string):Promise<Mission84ProviderRetryOffer>{
 const sha=process.env.VERCEL_GIT_COMMIT_SHA;
 if(projectId!==ORIGINAL_TTT_PROJECT||process.env.VERCEL_ENV!=='production'
    ||!sha||!/^[a-f0-9]{40}$/.test(sha))
  throw Error('Original mission84 current production release required');
 const offer=await rpc<Mission84ProviderRetryOffer>('project_org_m84_provider_retry_offer',{
  p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:projectId,p_release:sha
 });
 if(!offer||offer.projectId!==projectId||offer.releaseSha!==sha
    ||!['authorize','authorized'].includes(offer.stage)
    ||offer.scopeHash!==ORIGINAL_TTT_SCOPE
    ||offer.missionId!==M84_PROVIDER_MISSION||offer.assignmentId!==M84_PROVIDER_ASSIGNMENT
    ||!Number.isInteger(offer.releaseGeneration)||offer.releaseGeneration<=0
    ||!/^dpl_[A-Za-z0-9]+$/.test(offer.deploymentId)
    ||offer.historicalMissions!==84||offer.maxMissions!==96
    ||offer.tokenAllowance!==600000||offer.nodeCount!==13
    ||offer.newPaidAttempts!==1||offer.originalAttempts!==1
    ||!Number.isFinite(Date.parse(offer.cutoff))
    ||(offer.stage==='authorize'&&(
       offer.authorizationId!==null||offer.originalCalls!==0
       ||offer.originalRequestId!=='58d5926a-7160-42c1-9a04-540351e777dc'
       ||typeof offer.stateHash!=='string'||!/^[a-f0-9]{64}$/.test(offer.stateHash)))
    ||(offer.stage==='authorized'&&
      (!offer.authorizationId||!/^[0-9a-f-]{36}$/i.test(offer.authorizationId))))
   throw Error('Original Mission84 provider retry source or release changed');
 return {...offer,cutoff:new Date(offer.cutoff).toISOString()};
}
