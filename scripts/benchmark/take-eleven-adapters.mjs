// Exact current execution surfaces. No inference or project mutation is performed here.
// Adapters may not claim readiness without provider-enforced budget and usage evidence.
export const TAKE_ELEVEN_ARMS=Object.freeze({
 direct:Object.freeze({
  branch:'benchmark/take-eleven-direct',
  engine:'github-actions-codex',
  workflow:'.github/workflows/autonomous-development.yml',
  dispatchEvent:'workflow_dispatch',
  requires:['isolatedBranchCheckout','serverSideTokenCap','providerUsageReceipt','immutableAcceptance','ownerApprovalVerifier']
 }),
 orchestrated:Object.freeze({
  branch:'benchmark/take-eleven-orchestrated',
  engine:'katie-project-worker',
  source:'lib/projects/worker.ts',
  missionEngine:'lib/missions/worker.ts',
  requires:['isolatedProject','isolatedBranchCheckout','serverSideTokenCap','providerUsageReceipt','immutableAcceptance','ownerApprovalVerifier']
 })
});
export function adapterPreflight(arm, capabilities){
 const spec=TAKE_ELEVEN_ARMS[arm];
 if(!spec)throw Error('Unknown benchmark arm');
 const missing=spec.requires.filter(name=>capabilities?.[name]!==true);
 return {arm,ready:missing.length===0,missing};
}
export function authorizeBenchmarkPair(capabilities){
 const direct=adapterPreflight('direct',capabilities?.direct);
 const orchestrated=adapterPreflight('orchestrated',capabilities?.orchestrated);
 return {ready:direct.ready&&orchestrated.ready,direct,orchestrated};
}
