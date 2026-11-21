import {rpc} from '@/lib/missions/store';
import {ORIGINAL_TTT_PROJECT,ORIGINAL_TTT_SCOPE} from './management-activation';
import {MISSION79_ID,MISSION79_ASSIGNMENT} from './mission79-future-window';

export type Mission79RetryOffer={
 projectId:string;stage:'approve_retry'|'authorized'|'claimed'|'terminal';
 releaseSha:string;releaseGeneration:number;deploymentId:string;
 missionId:string;assignmentId:string;scopeHash:string;cutoff:string;
 authorizationId:string|null;authorizedAt?:string;
 originalAttempts:number;originalCalls:number;currentAttempts?:number;
 historicalMissions:number;maxMissions:number;tokenAllowance:number;nodeCount:number;
 stateHash?:string;
};

// A read-only offer is not consent. Only the authenticated first-party POST
// may create the immutable receipt and queue the same failed assignment.
export async function mission79RetryOffer(projectId:string):Promise<Mission79RetryOffer>{
 const sha=process.env.VERCEL_GIT_COMMIT_SHA;
 if(process.env.VERCEL_ENV!=='production'||projectId!==ORIGINAL_TTT_PROJECT
   ||!sha||!/^[0-9a-f]{40}$/.test(sha))
  throw Error('Exact original production retry release required');
 const offer=await rpc<Mission79RetryOffer>('project_org_mission79_retry_offer',{
  p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:projectId,p_release:sha
 });
 if(!offer||offer.projectId!==projectId||offer.releaseSha!==sha
  ||!['approve_retry','authorized','claimed','terminal'].includes(offer.stage)
  ||offer.missionId!==MISSION79_ID||offer.assignmentId!==MISSION79_ASSIGNMENT
  ||offer.scopeHash!==ORIGINAL_TTT_SCOPE
  ||!Number.isSafeInteger(offer.releaseGeneration)||offer.releaseGeneration<=0
  ||!/^dpl_[A-Za-z0-9]+$/.test(offer.deploymentId)
  ||!Number.isFinite(Date.parse(offer.cutoff))
  ||offer.originalAttempts!==1||offer.originalCalls!==1
  ||offer.historicalMissions!==79||offer.maxMissions!==96
  ||offer.tokenAllowance!==600000||offer.nodeCount!==13
  ||(offer.stage==='approve_retry'&&(offer.authorizationId!==null
    ||typeof offer.stateHash!=='string'||!/^[a-f0-9]{64}$/.test(offer.stateHash)))
  ||(offer.stage!=='approve_retry'&&
    (!offer.authorizationId||!/^[0-9a-f-]{36}$/i.test(offer.authorizationId)
     ||!offer.authorizedAt||!Number.isFinite(Date.parse(offer.authorizedAt)))))
  throw Error('Exact Mission79 retry evidence or release changed');
 return {...offer,cutoff:new Date(offer.cutoff).toISOString()};
}
