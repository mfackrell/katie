// Reuses the Full trusted HTTP bridge for Native/Thin, but settles against
// canonical benchmark calls (no artificial Developer mission projection).
import {createNativeHttpBridge} from './native-http-bridge.mjs';
import {issueNonFullTrustedGrant} from './nonfull-trusted-grant.mjs';
export async function createNonFullTrustedGateway({
 db,arm,trial,account,approval,ownerId,repository,upstream,clientToken,
 upperTokens,tokenFactory,providerNamespace='nonbillable-synthetic-fixture'
}){
 if(!['nonbillable-synthetic-fixture','openai-responses'].includes(providerNamespace)||
  (providerNamespace==='nonbillable-synthetic-fixture')!== (upstream?.nonbillableFixture===true))
  throw Error('NONFULL_GATEWAY_PROVIDER_MODE_INVALID');
 if(typeof upstream!=='function'||!Number.isSafeInteger(upperTokens)||
  upperTokens<1||upperTokens>account?.cap_tokens||!clientToken)
  throw Error('NONFULL_GATEWAY_CONFIGURATION_DENIED');
 const grant=await issueNonFullTrustedGrant({db,arm,trial,account,approval,
  ownerId,repository,tokenFactory});
 const server=createNativeHttpBridge({
  db,grantToken:grant.grantToken,trialId:grant.trialId,
  executionEpoch:grant.executionEpoch,providerNamespace,
  upperTokens,upstream,clientToken,fullMission:false,
  recordReceipt:grant.canonicalReceipt
 });
 return {server,grantId:grant.grantId,accountId:grant.accountId,trialId:grant.trialId};
}
