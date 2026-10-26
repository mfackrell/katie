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
 for(const key of ['contract_sha256','baseline_sha','model_policy_sha256','tool_profile_sha256','runtime_sha256']){
  if(typeof trial[key]!=='string'||!trial[key])throw Error('NONFULL_TRIAL_IDENTITY_INCOMPLETE');
 }
 return Object.freeze({arm,trialId:trial.id,accountId:account.id,approvalId:approval.id,
  model:approval.model,deadline:approval.deadline});
}
