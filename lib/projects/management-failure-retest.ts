import {rpc} from '@/lib/missions/store';
import {ORIGINAL_TTT_PROJECT,ORIGINAL_TTT_SCOPE} from './management-activation';
import {preflightManagementContext} from './management-context-preflight';

export type ManagementFailureRetestOffer={
  projectId:string;stage:'authorize'|'authorized';releaseSha:string;
  releaseGeneration:number;deploymentId:string;scopeHash:string;cutoff:string;
  missionId:string;assignmentId:string;principalId?:string;stateHash?:string;
  failureDigest?:string;authorizationId:string|null;authorizedAt?:string;
  historicalMissions:number;maxMissions:number;tokenAllowance:number;
  nodeCount:number;originalAttempts:number;originalCalls?:number;additionalAttempts:number;
  contextHash?:string;contextChars?:number;
};

// Read-only current failed-manager state + current decision-evidence validation. It never approves,
 // resumes, requeues, dispatches or spends. The SQL owner writer separately
 // rechecks its locked project-history fingerprint before accepting consent.
export async function managementFailureRetestOffer(projectId:string):Promise<ManagementFailureRetestOffer>{
  const sha=process.env.VERCEL_GIT_COMMIT_SHA;
  if(projectId!==ORIGINAL_TTT_PROJECT||process.env.VERCEL_ENV!=='production'
    ||!sha||!/^[a-f0-9]{40}$/.test(sha))throw Error('Original current production release required');
  const offer=await rpc<ManagementFailureRetestOffer>('project_org_management_failure_retest_offer',{
    p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:projectId,p_release:sha,
  });
  if(!offer||offer.projectId!==projectId||offer.releaseSha!==sha
    ||!['authorize','authorized'].includes(offer.stage)||offer.scopeHash!==ORIGINAL_TTT_SCOPE
    ||!Number.isSafeInteger(offer.releaseGeneration)||offer.releaseGeneration<=0
    ||!/^dpl_[A-Za-z0-9]+$/.test(offer.deploymentId)
    ||offer.maxMissions!==96||offer.tokenAllowance!==600000||offer.nodeCount!==13
    ||!Number.isSafeInteger(offer.historicalMissions)
    ||offer.historicalMissions<84||offer.historicalMissions>96
    ||offer.originalAttempts!==1||offer.additionalAttempts!==1
    ||!Number.isFinite(Date.parse(offer.cutoff))
    ||!/^[0-9a-f-]{36}$/i.test(offer.missionId)
    ||!/^[0-9a-f-]{36}$/i.test(offer.assignmentId))
    throw Error('Context retest source identity, owner scope or authority changed');
  if(offer.stage==='authorized'){
    if(!offer.authorizationId||!/^[0-9a-f-]{36}$/i.test(offer.authorizationId)
      ||!offer.authorizedAt||!Number.isFinite(Date.parse(offer.authorizedAt))
      ||typeof offer.contextHash!=='string'||!/^[a-f0-9]{64}$/.test(offer.contextHash)
      ||typeof offer.contextChars!=='number'||!Number.isSafeInteger(offer.contextChars)
      ||offer.contextChars<1||offer.contextChars>48000)
      throw Error('One-time owner retest receipt unavailable');
    return {...offer,cutoff:new Date(offer.cutoff).toISOString()};
  }
  if(offer.authorizationId!==null||offer.originalCalls!==0
    ||!offer.principalId||!/^[0-9a-f-]{36}$/i.test(offer.principalId)
    ||!offer.stateHash||!/^[a-f0-9]{64}$/.test(offer.stateHash)
    ||!offer.failureDigest||!/^[a-f0-9]{64}$/.test(offer.failureDigest))
    throw Error('Failed-management source preflight changed');
  const current=await preflightManagementContext(projectId,offer.principalId);
  if(current.inputLimit!==48000||current.organizationNodes!==13
    ||current.principalId!==offer.principalId||current.chars>48000)
    throw Error('Current management context cannot fit without losing required evidence');
  return {...offer,cutoff:new Date(offer.cutoff).toISOString(),
    contextHash:current.sha256,contextChars:current.chars};
}
