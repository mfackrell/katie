// Read-only benchmark launch gate. Never issues grants or starts paid inference.
// The caller must supply independently observed staging/authorization evidence.
import {readFileSync} from 'node:fs';
export function validateLaunchReadiness(manifest,evidence){
 const blockers=[];
 if(manifest?.issue!==715||manifest?.repository!=='mfackrell/katie'||manifest?.productionPublicationAllowed!==false)
  blockers.push('contract_identity');
 const arms=manifest?.arms;
 if(!Array.isArray(arms)||arms.length!==3||
  ['native','thin','full'].some(arm=>arms.filter(x=>x.arm===arm&&x.usdCeilingCents===1000).length!==1)||
  manifest.totalUsdCeilingCents!==3000)
  blockers.push('budget_contract');
 if(!/^[a-f0-9]{40}$/.test(manifest?.baselineSha||'')||manifest.model!=='gpt-5.3-codex')
  blockers.push('trial_parity');
 if(manifest?.paidExecutionEnabled!==false)blockers.push('paid_execution_switch');
 const checks={
  staging:(evidence?.branchStatus==='FUNCTIONS_DEPLOYED'||evidence?.branchStatus==='READY')&&
    evidence?.benchmarkSchemaPresent===true&&evidence?.stagingSeparateFromProduction===true,
  contract:evidence?.contractHashVerified===true&&evidence?.acceptanceHashVerified===true&&
    evidence?.baselineSha===manifest?.baselineSha,
  parity:evidence?.modelAndToolsMatched===true,
  pricing:evidence?.verifiedModel===manifest?.model&&evidence?.priceCeilingVerified===true,
  authorization:Array.isArray(evidence?.arms)&&evidence.arms.length===3&&
    ['native','thin','full'].every(arm=>{
     const a=evidence.arms.find(x=>x.arm===arm);
     return a?.trialRecorded===true&&a?.accountRecorded===true&&
      a?.ownerApprovalRecorded===true&&a?.deadlineVerified===true&&
      a?.hardUsdCapCents===1000&&a?.revocationVerified===true;
    }),
  dispatch:evidence?.ownerOnlyDispatchVerified===true&&evidence?.durableCheckpointVerified===true,
  acceptance:evidence?.privateBrowserVerifierReady===true&&evidence?.independentEvidenceVerifierReady===true,
  reconciliation:evidence?.canonicalReceiptPathVerified===true
 };
 for(const [name,passed] of Object.entries(checks))if(!passed)blockers.push(name);
 return {ready: blockers.length===0, blockers, checks, paidExecutionAuthorized:false};
}
if(process.argv[1]&&process.argv[1].endsWith('benchmark-715-readiness.mjs')){
 const [,,manifestPath,evidencePath]=process.argv;
 if(!manifestPath||!evidencePath)throw Error('READINESS_REQUIRES_MANIFEST_AND_EVIDENCE');
 const result=validateLaunchReadiness(JSON.parse(readFileSync(manifestPath,'utf8')),
  JSON.parse(readFileSync(evidencePath,'utf8')));
 console.log(JSON.stringify(result,null,2));
 if(!result.ready)process.exitCode=1;
}
