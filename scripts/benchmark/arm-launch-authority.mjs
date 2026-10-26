import {createHash} from 'node:crypto';
// Trusted Native/Thin entrypoint authority. A trial flag or model-authored
// payload is NEVER spending authorization. Native/Thin cannot impersonate Full.
export function verifyNonFullLaunch({arm,trial,account,approval,ownerId,repository,now=Date.now()}){
 if(arm!=='native'&&arm!=='thin')throw Error('NONFULL_ARM_REQUIRED');
 if(!trial||!account||!approval||!ownerId||!repository)
  throw Error('NONFULL_AUTHORITY_INCOMPLETE');
 if(trial.arm!==arm||trial.state!=='qualified'||
    account.arm!==arm||account.trial_id!==trial.id||
    account.owner_actor_id!==trial.owner_actor_id||
    approval.trial_id!==trial.id||approval.account_id!==account.id||
    approval.actor_id!==trial.owner_actor_id||
    approval.owner_id!==ownerId||approval.repository!==repository||
    approval.revoked_at||approval.consumed_at||
    !Number.isFinite(Date.parse(approval.deadline))||
    Date.parse(approval.deadline)<=now||
    account.frozen_at||!Number.isSafeInteger(Number(approval.max_tokens))||
    Number(approval.max_tokens)<=0||Number(account.cap_tokens)>Number(approval.max_tokens)||
    approval.task_id!=null||approval.project_id!=null||approval.mission_assignment_id!=null)
  throw Error('NONFULL_OWNER_AUTHORITY_DENIED');
 const contract={experimentId:trial.experiment_id,replicate:trial.replicate,
  baselineSha:trial.baseline_sha,contractSha256:trial.contract_sha256,
  acceptanceSha256:trial.acceptance_sha256,toolProfileSha256:trial.tool_profile_sha256,
  modelPolicySha256:trial.model_policy_sha256,runtimeSha256:trial.runtime_sha256,
  tokenCap:Number(account.cap_tokens)};
 const computed=createHash('sha256').update(JSON.stringify(contract)).digest('hex');
 if(approval.protocol_digest!==computed)throw Error('NONFULL_PROTOCOL_AUTHORITY_MISMATCH');
 for(const key of ['contract_sha256','baseline_sha','model_policy_sha256','tool_profile_sha256','runtime_sha256','acceptance_sha256']){
  if(typeof trial[key]!=='string'||!trial[key])throw Error('NONFULL_TRIAL_IDENTITY_INCOMPLETE');
 }
 return Object.freeze({arm,trialId:trial.id,accountId:account.id,approvalId:approval.id,
  model:approval.model,deadline:approval.deadline});
}
