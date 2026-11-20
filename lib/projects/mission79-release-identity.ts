// Original mission79 production authority is bound to an exact Vercel
// deployment, database release generation, and owner-visible read-only offer.
// The runtime deployment ID is a Vercel system environment variable, never
// supplied or inferred from an untrusted browser payload.
export type Mission79ReleaseEpoch={
 active:boolean;generation:number;deploymentId:string|null;
};
export type Mission79ReleaseSelection={
 releaseGeneration:number;deploymentId:string;
};
export type Mission79ReleaseIdentityFailure=
 |'inactive_release_gate'|'invalid_database_release_epoch'
 |'runtime_deployment_id_missing'|'runtime_deployment_id_invalid'
 |'runtime_deployment_id_mismatch'|'stale_release_generation'
 |'stale_owner_deployment_offer';

// Do not weaken this validation or accept a caller-provided runtime identity.
// A missing VERCEL_DEPLOYMENT_ID requires enabling Vercel's automatic system
// environment variables and creating a new deployment, not bypassing the gate.
export function mission79ReleaseIdentityFailure(
 epoch:Mission79ReleaseEpoch|null|undefined,
 selected:Mission79ReleaseSelection,
 runtimeDeploymentId:string|undefined
):Mission79ReleaseIdentityFailure|null{
 if(!epoch?.active)return 'inactive_release_gate';
 if(!Number.isSafeInteger(epoch.generation)||epoch.generation<=0
  ||!epoch.deploymentId||!/^dpl_[A-Za-z0-9]+$/.test(epoch.deploymentId))
  return 'invalid_database_release_epoch';
 if(!runtimeDeploymentId)return 'runtime_deployment_id_missing';
 if(!/^dpl_[A-Za-z0-9]+$/.test(runtimeDeploymentId))
  return 'runtime_deployment_id_invalid';
 if(epoch.deploymentId!==runtimeDeploymentId)
  return 'runtime_deployment_id_mismatch';
 if(epoch.generation!==selected.releaseGeneration)
  return 'stale_release_generation';
 if(epoch.deploymentId!==selected.deploymentId)
  return 'stale_owner_deployment_offer';
 return null;
}
export function mission79ReleaseIdentityMessage(failure:Mission79ReleaseIdentityFailure):string{
 if(failure==='runtime_deployment_id_missing'||failure==='runtime_deployment_id_invalid')
  return 'Vercel runtime deployment identity is unavailable. Enable System Environment Variables and redeploy; no owner authorization was recorded.';
 if(failure==='stale_release_generation'||failure==='stale_owner_deployment_offer')
  return 'The release changed after this owner approval form loaded. Refresh project status before approving; no owner authorization was recorded.';
 return 'The canonical production deployment and the original mission79 security gate do not match. Release reconciliation is required before approval.';
}
