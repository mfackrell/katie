import {rpc} from '@/lib/missions/store';
import {ORIGINAL_TTT_PROJECT,ORIGINAL_TTT_SCOPE} from './management-activation';

// Exact current source; the old owner window is already recorded and is never renewed here.
export const BLOCKED_RETEST_SOURCE='911d15bd-be5f-416e-bbac-fbe86ca6fa90';
export const BLOCKED_RETEST_WINDOW='7d216bbe-596e-457e-b84d-e07ad1e80365';
export const BLOCKED_RETEST_CUTOFF='2026-11-18T14:00:00Z';

export type BlockedManagementRetestOffer={
 projectId:string;stage:'retest'|'admitted';status:string;
 sourceMissionId:string;windowId:string;scopeHash:string;
 releaseSha:string;admittedReleaseSha?:string;cutoff:string;
 historicalMissions:number;maxMissions:number;tokenAllowance:number;nodeCount:number;
 stateHash:string;authorizedAt?:string;
};

export async function blockedManagementRetestOffer(projectId:string):Promise<BlockedManagementRetestOffer>{
 const release=process.env.VERCEL_GIT_COMMIT_SHA;
 if(projectId!==ORIGINAL_TTT_PROJECT||process.env.VERCEL_ENV!=='production'
  ||!release||!/^[a-f0-9]{40}$/.test(release))
  throw Error('One-time management retest requires the exact active production release.');
 const offer=await rpc<BlockedManagementRetestOffer>('project_org_blocked_management_retest_offer',{
  p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:projectId,p_release:release,
 });
 if(!offer||offer.projectId!==projectId||offer.releaseSha!==release
  ||offer.sourceMissionId!==BLOCKED_RETEST_SOURCE||offer.windowId!==BLOCKED_RETEST_WINDOW
  ||offer.scopeHash!==ORIGINAL_TTT_SCOPE
  ||Date.parse(offer.cutoff)!==Date.parse(BLOCKED_RETEST_CUTOFF)
  ||offer.historicalMissions!==78||offer.maxMissions!==96
  ||offer.tokenAllowance!==600000||offer.nodeCount!==13
  ||!/^[a-f0-9]{64}$/.test(offer.stateHash)
  ||!['retest','admitted'].includes(offer.stage)
  ||(offer.stage==='retest'&&(offer.status!=='blocked'
    ||Date.now()>=Date.parse(BLOCKED_RETEST_CUTOFF)-300000))
  ||(offer.stage==='admitted'&&(!offer.authorizedAt
    ||!Number.isFinite(Date.parse(offer.authorizedAt))
    ||!offer.admittedReleaseSha||!/^[a-f0-9]{40}$/.test(offer.admittedReleaseSha))))
  throw Error('Original blocked management retest receipt or authorization changed.');
 return {...offer,cutoff:BLOCKED_RETEST_CUTOFF};
}
