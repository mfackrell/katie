import {rpc} from '@/lib/missions/store';

export const ORIGINAL_TTT_PROJECT='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
export const APPROVED_TTT_CUTOFF='2026-11-16T18:00:00Z';
export const ORIGINAL_TTT_SCOPE='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
export type ManagementActivationOffer={
 projectId:string;stage:'renew'|'resume'|'resumed'|'expired';releaseSha:string;expectedReleaseSha:string;
 scopeHash:string;sourceMissionId:string;windowId:string;priorCutoff:string;cutoff:string;
 renewalStateHash?:string;stateHash:string;authorizationId:string|null;status:string;historicalMissions:number;
 maxMissions:number;tokenAllowance:number;nodeCount:number;
};
export async function managementActivationOffer(projectId:string):Promise<ManagementActivationOffer>{
 const release=process.env.VERCEL_GIT_COMMIT_SHA;
 if(process.env.VERCEL_ENV!=='production'||!release||!/^[a-f0-9]{40}$/.test(release)||projectId!==ORIGINAL_TTT_PROJECT)
  throw Error('Recovery requires the original project on the active production release.');
 const offer=await rpc<ManagementActivationOffer>('project_org_management_activation_offer',{
  p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:projectId,p_release:release,
 });
 if(!offer||offer.projectId!==projectId||offer.releaseSha!==release||offer.scopeHash!==ORIGINAL_TTT_SCOPE
  ||offer.sourceMissionId!=='62cd8da3-1bcc-41ae-9470-574c6b05e420'
  ||offer.maxMissions!==96||offer.tokenAllowance!==600000||offer.nodeCount!==13
  ||!Number.isInteger(offer.historicalMissions)||offer.historicalMissions<73
  ||!/^[a-f0-9]{64}$/.test(offer.stateHash)||Date.parse(offer.cutoff)!==Date.parse(APPROVED_TTT_CUTOFF)
  ||!['renew','resume','resumed'].includes(offer.stage))throw Error('Original project or durable recovery receipt changed. Refresh project status.');
 if(offer.stage!=='resumed'&&Date.now()>=Date.parse(APPROVED_TTT_CUTOFF)-300000)
  return {...offer,cutoff:APPROVED_TTT_CUTOFF,stage:'expired'};
 return {...offer,cutoff:APPROVED_TTT_CUTOFF};
}
