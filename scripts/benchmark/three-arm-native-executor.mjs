import {validateThreeArmProtocol,ARMS} from './three-arm-protocol.mjs';
import {runNativeBenchmark} from './native-agent-runtime.mjs';

// All arms MUST use this same native execution function. Treatments are external
// approved preparation/review policies, not alternate model engines.
// This only stages nonbillable/mockable integration; a verified spending gateway
// must exist separately before any paid work can be admitted.
export async function executeThreeArmTreatments({
 protocol,workspaces,createCodex,gateway,approvals,qualifications,
 homeRoots,model,composeTreatment,onEvent=()=>{}
}){
 const validated=validateThreeArmProtocol(protocol);
 if(typeof composeTreatment!=='function'||typeof createCodex!=='function')
  throw Error('BENCHMARK_ENGINE_REQUIRED');
 if(!gateway?.id||!gateway?.baseUrl)throw Error('BENCHMARK_GATEWAY_REQUIRED');
 // Deliberately non-production: this branch has no trusted admission token or
 // durable native provider gateway. Never forward to a reachable paid endpoint.
 if(!/^https:\\/\\/[a-z0-9.-]+\\.invalid(?:\\/|$)/.test(gateway.baseUrl))
  throw Error('BENCHMARK_NONBILLABLE_GATEWAY_ONLY');
 if(!workspaces||!approvals||!qualifications||!homeRoots)
  throw Error('BENCHMARK_ARM_BINDINGS_REQUIRED');
 const inputs=[];
 // Preflight ALL arms before dispatching ANY to avoid half a comparison.
 for(const arm of ARMS){
  const trial=protocol.trials.find(t=>t.arm===arm);
  const workspace=workspaces[arm],approval=approvals[arm],qualification=qualifications[arm],home=homeRoots[arm];
  if(typeof workspace!=='string'||!workspace||typeof home!=='string'||!home.startsWith('/')||
     approval?.accountId===undefined||approval?.gatewayId!==gateway.id||
     qualification?.accountId!==approval.accountId||qualification?.gatewayId!==gateway.id)
   throw Error('BENCHMARK_ARM_PREFLIGHT_DENIED:'+arm);
  const treatment=await composeTreatment({arm,trial,protocol,protocolDigest:validated.protocolDigest});
  if(typeof treatment?.prompt!=='string'||!treatment.prompt.trim()||
     treatment.contractSha256!==protocol.contractSha256||
     treatment.baselineSha!==protocol.baselineSha||
     treatment.modelPolicySha256!==protocol.modelPolicySha256||
     treatment.toolProfileSha256!==protocol.toolProfileSha256||
     treatment.runtimeSha256!==protocol.runtimeSha256)
   throw Error('BENCHMARK_TREATMENT_IDENTITY_INVALID:'+arm);
  inputs.push({arm,workspace,approval,qualification,home,prompt:treatment.prompt});
 }
 const outputs=[];
 for(const item of inputs){
  const result=await runNativeBenchmark({
   createCodex,gateway,arm:item.arm,workingDirectory:item.workspace,
   prompt:item.prompt,model,approvedAccountId:item.approval.accountId,
   approvalReceipt:item.approval,isolatedHome:item.home,
   isolatedCodexHome:item.home+'/.codex',
   runtimeQualification:item.qualification,
   onEvent:event=>onEvent({arm:item.arm,event})
  });
  outputs.push({arm:item.arm,threadId:result.threadId,
   accounting:result.accounting,accepted:false,
   protocolDigest:validated.protocolDigest});
 }
 return {experimentId:protocol.experimentId,replicate:protocol.replicate,
  protocolDigest:validated.protocolDigest,paidExecutionAuthorized:false,
  acceptanceVerified:false,results:outputs};
}
