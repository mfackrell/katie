import {randomBytes} from 'node:crypto';
import {tokenDigest} from './authenticated-native-gateway.mjs';
import {verifyNonFullLaunch} from './arm-launch-authority.mjs';
import {createCanonicalReceiptWriter} from './native-provider-receipts.mjs';

// Shared trusted host entrypoint for real Native/Thin grant + canonical
// receipt settlement. Full continues using linked mission settlement.
// This module has no standalone credential handling or agent-issued approval.
export async function issueNonFullTrustedGrant({db,arm,trial,account,approval,
 ownerId,repository,now=Date.now(),tokenFactory=()=>randomBytes(48).toString('base64url')}){
 if(!db||typeof db.rpc!=='function')throw Error('NONFULL_DB_REQUIRED');
 const checked=verifyNonFullLaunch({arm,trial,account,approval,ownerId,repository,now});
 const grantToken=tokenFactory();
 const digest=tokenDigest(grantToken);
 const {data:grantId,error}=await db.rpc('benchmark_issue_nonfull_execution_grant',{
  p_owner:ownerId,p_actor:approval.actor_id,p_chat:approval.chat_id,
  p_trial:trial.id,p_approval:approval.id,p_repository:repository,
  p_model:approval.model,p_epoch:1,p_deadline:approval.deadline,p_digest:digest
 });
 if(error||typeof grantId!=='string'||!grantId)
  throw Error('NONFULL_ATOMIC_GRANT_DENIED');
 return Object.freeze({...checked,grantId,grantToken,executionEpoch:1,
  canonicalReceipt:createCanonicalReceiptWriter(db)});
}
