import {rpc} from '@/lib/missions/store';
import {ORIGINAL_TTT_PROJECT,ORIGINAL_TTT_SCOPE} from '@/lib/projects/management-activation';

// A read-only first-party offer. A displayed date never grants authority.
export const ORIGINAL_BLOCKED_WINDOW='a08d3cac-6e3f-4c14-a75a-5f524987a676';
export const ORIGINAL_BLOCKED_CUTOFF='2026-11-16T18:00:00Z';
export const ORIGINAL_BLOCKED_SOURCE='62cd8da3-1bcc-41ae-9470-574c6b05e420';
export type BlockedOwnerOffer={
 projectId:string;stage:'authorize'|'resume'|'resumed'|'expired';
 releaseSha:string;expectedReleaseSha:string;scopeHash:string;sourceMissionId:string;
 priorWindowId:string;windowId:string;priorCutoff:string;cutoff:string|null;
 authorizationId:string|null;stateHash:string;status:string;historicalMissions:number;
 maxMissions:number;tokenAllowance:number;nodeCount:number;maxHours:number;
 authorizedAt?:string|null;
};
export async function blockedOwnerRecoveryOffer(projectId:string):Promise<BlockedOwnerOffer>{
 const release=process.env.VERCEL_GIT_COMMIT_SHA;
 if(projectId!==ORIGINAL_TTT_PROJECT||process.env.VERCEL_ENV!=='production'
  ||!release||!/^[a-f0-9]{40}$/.test(release))
  throw Error('Original owner recovery requires an active production release.');
 const offer=await rpc<BlockedOwnerOffer>('project_org_blocked_owner_offer',{
  p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:projectId,p_release:release,
 });
 if(!offer||offer.projectId!==projectId||offer.releaseSha!==release
  ||offer.scopeHash!==ORIGINAL_TTT_SCOPE||offer.sourceMissionId!==ORIGINAL_BLOCKED_SOURCE
  ||offer.priorWindowId!==ORIGINAL_BLOCKED_WINDOW
  ||Date.parse(offer.priorCutoff)!==Date.parse(ORIGINAL_BLOCKED_CUTOFF)
  ||offer.maxMissions!==96||offer.tokenAllowance!==600000||offer.nodeCount!==13
  ||offer.historicalMissions!==76||offer.maxHours!==24
  ||!['authorize','resume','resumed','expired'].includes(offer.stage)
  ||!/^[a-f0-9]{64}$/.test(offer.stateHash)
  ||!/^[a-f0-9]{40}$/.test(offer.expectedReleaseSha)
  ||(offer.stage==='authorize'&&(offer.authorizationId!==null||offer.cutoff!==null||offer.status!=='blocked'))
  ||(offer.stage!=='authorize'&&(!/^[a-f0-9-]{36}$/i.test(offer.authorizationId??'')
    ||!offer.cutoff||!Number.isFinite(Date.parse(offer.cutoff))
    ||(offer.stage==='resumed'&&offer.status!=='running')
    ||(offer.stage!=='resumed'&&offer.status!=='blocked'))))
  throw Error('Original project or durable blocked recovery evidence changed.');
 // PostgreSQL serializes timestamptz with +00:00; the owner API uses exact
 // canonical ISO strings so its strict input literals cannot reject the
 // authentic preflight receipt before the state/authority checks execute.
 return {...offer,priorCutoff:ORIGINAL_BLOCKED_CUTOFF,
  cutoff:offer.cutoff?new Date(offer.cutoff).toISOString():null};
}
