import {rpc} from '@/lib/missions/store';
import {ORIGINAL_TTT_PROJECT,ORIGINAL_TTT_SCOPE} from './management-activation';

// Read-only owner offer: never substitutes a deadline, auth token or release.
export const MISSION79_ID='b7c2e557-83e1-41cb-b174-bdb0d77d12e5';
export const MISSION79_ASSIGNMENT='85e229aa-e571-43ef-9d4a-5cb64f4efcd1';
export const MISSION79_SOURCE='911d15bd-be5f-416e-bbac-fbe86ca6fa90';
export const MISSION79_PRIOR_WINDOW='7d216bbe-596e-457e-b84d-e07ad1e80365';
export const MISSION79_PRIOR_CUTOFF='2026-11-18T14:00:00Z';

export type Mission79FutureWindowOffer={
 projectId:string;stage:'authorize'|'authorized'|'bound';
 releaseSha:string;releaseGeneration:number;deploymentId:string;status:'blocked'|'running';missionStatus:'blocked'|'running';
 sourceMissionId:string;missionId:string;assignmentId:string;
 priorWindowId:string;authorizationId:string|null;
 scopeHash:string;priorCutoff:string;cutoff:string|null;
 historicalMissions:number;maxMissions:number;tokenAllowance:number;nodeCount:number;
 stateHash:string;authorizedAt?:string;boundAt?:string;
};

export async function mission79FutureWindowOffer(projectId:string):Promise<Mission79FutureWindowOffer>{
 const sha=process.env.VERCEL_GIT_COMMIT_SHA;
 if(projectId!==ORIGINAL_TTT_PROJECT||process.env.VERCEL_ENV!=='production'
  ||!sha||!/^[a-f0-9]{40}$/.test(sha))throw Error('Exact production owner recovery required');
 const offer=await rpc<Mission79FutureWindowOffer>('project_org_retest_future_window_offer',{
  p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:projectId,p_release:sha
 });
 if(!offer||offer.projectId!==projectId||offer.releaseSha!==sha
  ||!Number.isSafeInteger(offer.releaseGeneration)||offer.releaseGeneration<=0
  ||!/^dpl_[A-Za-z0-9]+$/.test(offer.deploymentId)
  ||offer.sourceMissionId!==MISSION79_SOURCE||offer.missionId!==MISSION79_ID
  ||offer.assignmentId!==MISSION79_ASSIGNMENT||offer.priorWindowId!==MISSION79_PRIOR_WINDOW
  ||offer.scopeHash!==ORIGINAL_TTT_SCOPE
  ||Date.parse(offer.priorCutoff)!==Date.parse(MISSION79_PRIOR_CUTOFF)
  ||offer.historicalMissions!==79||offer.maxMissions!==96
  ||offer.tokenAllowance!==600000||offer.nodeCount!==13
  ||!['authorize','authorized','bound'].includes(offer.stage)
  ||!/^[a-f0-9]{64}$/.test(offer.stateHash)
  ||(offer.stage==='authorize'&&(offer.cutoff!==null||offer.authorizationId!==null
   ||offer.status!=='blocked'||offer.missionStatus!=='blocked'))
  ||(offer.stage!=='authorize'&&(!offer.cutoff||!Number.isFinite(Date.parse(offer.cutoff))
   ||!offer.authorizationId||!/^[0-9a-f-]{36}$/i.test(offer.authorizationId)
   ||typeof offer.authorizedAt!=='string'||!Number.isFinite(Date.parse(offer.authorizedAt))
   ||(offer.stage==='authorized'&&(offer.status!=='blocked'||offer.missionStatus!=='blocked'))
   ||(offer.stage==='bound'&&(offer.status!=='running'||offer.missionStatus!=='running')))))
  throw Error('Original mission79 owner window receipt changed; no authorization performed');
 return {...offer,priorCutoff:MISSION79_PRIOR_CUTOFF,
  cutoff:offer.cutoff?new Date(offer.cutoff).toISOString():null};
}
