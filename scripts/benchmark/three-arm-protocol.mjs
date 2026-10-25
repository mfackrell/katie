import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
export const ARMS=Object.freeze(['native','thin','full']);
const sha=(s,n)=>typeof s==='string'&&new RegExp('^[0-9a-f]{'+n+'}$').test(s);
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function validateThreeArmProtocol(p){
 if(!p||typeof p!=='object'||!sha(p.baselineSha,40)||!sha(p.contractSha256,64)||
    !sha(p.acceptanceSha256,64)||!sha(p.toolProfileSha256,64)||
    !sha(p.modelPolicySha256,64)||!sha(p.runtimeSha256,64)||
    !/^[0-9a-f-]{36}$/.test(p.experimentId??'')||
    !Number.isSafeInteger(p.replicate)||p.replicate<1||
    !Number.isSafeInteger(p.tokenCap)||p.tokenCap<=0)
  throw Error('BENCHMARK_PROTOCOL_INVALID');
 if(!Array.isArray(p.trials)||p.trials.length!==3||
    new Set(p.trials.map(x=>x.arm)).size!==3||
    !ARMS.every(arm=>p.trials.some(x=>x.arm===arm)))
  throw Error('BENCHMARK_REQUIRES_THREE_ARMS');
 for(const t of p.trials){
  if(t.baselineSha!==p.baselineSha||t.contractSha256!==p.contractSha256||
     t.acceptanceSha256!==p.acceptanceSha256||
     t.toolProfileSha256!==p.toolProfileSha256||
     t.modelPolicySha256!==p.modelPolicySha256||t.runtimeSha256!==p.runtimeSha256)
    throw Error('BENCHMARK_INCOMPARABLE_TRIAL');
  if(!sha(t.candidateSha,40)&&t.candidateSha!==null)
    throw Error('BENCHMARK_CANDIDATE_SHA_INVALID');
 }
 return Object.freeze({experimentId:p.experimentId,replicate:p.replicate,
  protocolDigest:digest({experimentId:p.experimentId,replicate:p.replicate,
   baselineSha:p.baselineSha,contractSha256:p.contractSha256,
   acceptanceSha256:p.acceptanceSha256,toolProfileSha256:p.toolProfileSha256,
   modelPolicySha256:p.modelPolicySha256,runtimeSha256:p.runtimeSha256,tokenCap:p.tokenCap})});
}
export function reconcileThreeArmTrial(protocol,records){
 const identity=validateThreeArmProtocol(protocol);
 if(!Array.isArray(records)||records.length!==3||new Set(records.map(x=>x.arm)).size!==3||
    !ARMS.every(a=>records.some(x=>x.arm===a)))throw Error('BENCHMARK_RECONCILIATION_MISSING_ARM');
 const results=records.map(r=>{
  const trial=protocol.trials.find(t=>t.arm===r.arm);
  if(!trial||r.protocolDigest!==identity.protocolDigest||
    r.candidateSha!==trial.candidateSha)throw Error('BENCHMARK_RECEIPT_IDENTITY_MISMATCH');
  if(!Array.isArray(r.operations)||!Array.isArray(r.acceptanceChecks))
   throw Error('BENCHMARK_MISSING_EVIDENCE');
  const seen=new Set();let actual=0,held=0,unknown=0;
  for(const op of r.operations){
   if(typeof op.id!=='string'||!op.id||seen.has(op.id))throw Error('BENCHMARK_DUPLICATE_OPERATION');
   seen.add(op.id);
   if(!['routing','planning','coding','compaction','review','recovery','synthesis','tool','infrastructure'].includes(op.stage))
    throw Error('BENCHMARK_UNATTRIBUTED_OPERATION');
   if(!Number.isSafeInteger(op.reservedTokens)||op.reservedTokens<0)
    throw Error('BENCHMARK_INVALID_RESERVATION');
   if(op.status==='settled'){
    if(!Number.isSafeInteger(op.actualTokens)||op.actualTokens<0||
       !op.authoritativeReceipt)throw Error('BENCHMARK_UNVERIFIED_PROVIDER_RECEIPT');
    actual+=op.actualTokens;
   }else if(op.status==='unresolved'){
    held+=op.reservedTokens;unknown++;
   }else throw Error('BENCHMARK_UNSUPPORTED_OPERATION_STATE');
  }
  if(actual+held>protocol.tokenCap)throw Error('BENCHMARK_ACCOUNT_OVER_CEILING');
  const acceptanceComplete=r.acceptanceChecks.length>0&&
   r.acceptanceChecks.every(x=>x.contractSha256===protocol.contractSha256&&
    x.acceptanceSha256===protocol.acceptanceSha256&&
    x.candidateSha===r.candidateSha&&x.protected===true&&x.passed===true&&
    typeof x.evidenceId==='string'&&x.evidenceId.length>0);
  return {arm:r.arm,candidateSha:r.candidateSha,actualTokens:actual,
   unresolvedHeldTokens:held,unresolvedOperations:unknown,
   acceptanceComplete:acceptanceComplete&&unknown===0,
   status:acceptanceComplete&&unknown===0?'evidence-complete':'unverified'};
 });
 return {experimentId:identity.experimentId,replicate:identity.replicate,
  protocolDigest:identity.protocolDigest,accepted:results.every(r=>r.acceptanceComplete),
  results};
}
// Analysis only; never executes models, constructs owner grants, or mints paid authorization.
export function buildReport(protocol,records){
 const report=reconcileThreeArmTrial(protocol,records);
 return {...report,paidExecutionAuthorized:false,
  comparisonValid:report.accepted&&report.results.every(x=>x.unresolvedHeldTokens===0)};
}
