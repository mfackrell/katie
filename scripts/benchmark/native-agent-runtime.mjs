// Native Codex SDK execution with a mandatory upstream metering boundary.
// This preserves the SDK's repo/shell/editor/session execution loop. No paid
// request is authorized by this module: the upstream gateway must authenticate
// its account and atomically reserve EACH model request before forwarding.
// Factory injection permits nonbillable tests without loading the SDK.
export async function runNativeBenchmark({
  createCodex, gateway, arm, workingDirectory, prompt, model, sandbox='workspace-write',
  approvedAccountId, approvalReceipt, isolatedHome, isolatedCodexHome, runtimeQualification, onEvent=()=>{}
}) {
 if(!['native','thin','full'].includes(arm))throw Error('BENCHMARK_ARM_INVALID');
 if(!gateway||gateway.attested!==true||gateway.enforcesEveryRequest!==true||
    !/^https:\/\//.test(gateway.baseUrl??'')||
    typeof gateway.id!=='string'||!gateway.id)
   throw Error('BENCHMARK_GATEWAY_NOT_VERIFIED');
 if(typeof approvedAccountId!=='string'||!approvedAccountId||
    approvalReceipt?.accountId!==approvedAccountId||
    approvalReceipt?.gatewayId!==gateway.id||
    approvalReceipt?.status!=='approved')
   throw Error('BENCHMARK_OWNER_AUTHORIZATION_REQUIRED');
 if(runtimeQualification?.verified!==true || runtimeQualification?.gatewayId!==gateway.id ||
    runtimeQualification?.accountId!==approvedAccountId ||
    runtimeQualification?.realSdkTested!==true || runtimeQualification?.providerBypassDenied!==true)
   throw Error('BENCHMARK_RUNTIME_NOT_QUALIFIED');
 if(typeof isolatedHome!=='string'||!isolatedHome.startsWith('/')||
    typeof isolatedCodexHome!=='string'||!isolatedCodexHome.startsWith('/')||
    isolatedHome===process.env.HOME||isolatedCodexHome===process.env.CODEX_HOME||
    !isolatedCodexHome.startsWith(isolatedHome+'/'))
   throw Error('BENCHMARK_ISOLATED_HOME_REQUIRED');
 if(!workingDirectory||!prompt||!model||typeof createCodex!=='function')
   throw Error('BENCHMARK_RUNTIME_CONFIG_INVALID');
 if(!['workspace-write','read-only'].includes(sandbox))
   throw Error('BENCHMARK_SANDBOX_INVALID');
 const runtime=await createCodex({
  baseUrl:gateway.baseUrl,
  // Avoid inheriting arbitrary host variables and alternate upstream keys.
  env:{PATH:process.env.PATH??'',HOME:isolatedHome,CODEX_HOME:isolatedCodexHome,
       CODEX_SQLITE_HOME:isolatedCodexHome,
       BENCHMARK_GATEWAY_ACCOUNT:approvedAccountId}
 });
 const thread=runtime.startThread({
  workingDirectory,model,sandboxMode:sandbox,skipGitRepoCheck:false
 });
 const {events}=await thread.runStreamed(prompt);
 let completed=false,usage=null;
 for await(const event of events){
  await onEvent(event);
  if(event.type==='turn.completed'){completed=true;usage=event.usage??null}
  if(event.type==='turn.failed')throw Error('BENCHMARK_NATIVE_TURN_FAILED');
 }
 if(!completed)throw Error('BENCHMARK_NATIVE_TURN_INCOMPLETE');
 // Native usage may be cumulative after resume; gateway ledger is authoritative.
 return {threadId:thread.id??null,usageInformational:usage,
  accounting:'REQUIRES_GATEWAY_RECONCILIATION',accepted:false};
}
