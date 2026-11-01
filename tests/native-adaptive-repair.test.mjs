import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {executeNativeDevelopmentLifecycle} from '../scripts/benchmark/native-development-lifecycle.mjs';

// Frozen synthetic assignment: aggregate integer-cent, non-void transactions.
// Independent subprocesses evaluate real candidate modules. No model requests,
// database credentials, manufactured verdicts, or owner-consent records exist.
const correct=[
 'export const total = rows => rows.filter(r => !r.void).reduce((n,r) => n+r.cents,0);',
 'export const count = rows => rows.filter(r => !r.void).length;',
 'export const largest = rows => rows.filter(r => !r.void).reduce((n,r) => Math.max(n,r.cents),0);'
];
const broken=[
 'export const total = rows => rows.filter(r => !r.void).reduce((n,r) => n+r.cents,1);',
 'export const count = rows => rows.length;',
 'export const largest = rows => rows.reduce((n,r) => Math.max(n,r.cents),0);'
];
const acceptance=`
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.argv[2]).href);
const rows=[{cents:120},{cents:80},{cents:999,void:true}];
const checks=[
 ['total',()=>{assert.equal(api.total(rows),200);assert.equal(api.total([]),0);}],
 ['count',()=>{assert.equal(api.count(rows),2);assert.equal(api.count([]),0);}],
 ['largest',()=>{assert.equal(api.largest(rows),120);assert.equal(api.largest([]),0);}]
];
const failures=[];for(const [id,run]of checks){try{run();}catch(error){failures.push(id+': '+error.message);}}
console.log(JSON.stringify({pid:process.pid,failures}));
`;
async function fixture({defects=[0,1,2],repair,denyRepair,reviewMismatch=false,verifierOnly=[],initialReviewOnly=[]}={}){
 const root=mkdtempSync(join(tmpdir(),'native-adaptive-'));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const phases=[],reviews=[],verifications=[],trace=[],checkpoints=[];let repairs=0,lastCompleted={};
 const source=join(root,'candidate.mjs'),contract=join(root,'frozen-acceptance.mjs');
 let lines=correct.map((line,i)=>defects.includes(i)?broken[i]:line);
 const save=()=>writeFileSync(source,lines.join('\n')+'\n');
 const evaluate=()=>JSON.parse(execFileSync(process.execPath,[contract,source],{encoding:'utf8'}));
 const accounting=Object.freeze({spent:900,reserved:20,task:'same-task',grant:'existing-grant'});
 const initialAccounting=JSON.stringify(accounting);
 try{
  git('init','-q');git('config','user.name','Synthetic qualification');git('config','user.email','qualification@example.invalid');
  writeFileSync(contract,acceptance);git('add','.');git('commit','-qm','Frozen original acceptance criteria');
  const contractBlob=git('hash-object','frozen-acceptance.mjs');
  let result,error;
  try{result=await executeNativeDevelopmentLifecycle({qualifiedLifecycle:true,
   runPhase:async(phase,findings)=>{
    phases.push(phase);
    assert.equal(git('hash-object','frozen-acceptance.mjs'),contractBlob,'Approved acceptance criteria remain immutable');
    assert.equal(JSON.stringify(accounting),initialAccounting,'Control decisions do not reset historical accounting');
    if(phase==='implementation'){save();return;}
    if(phase==='repair'){
     if(denyRepair?.(repairs))throw Error(denyRepair.reason??'NATIVE_OWNER_APPROVAL_REQUIRED: existing resource authority exhausted');
     repairs++;
     if(repair)lines=repair({lines:[...lines],repairs,findings,correct,broken});
     else{const i=lines.findIndex((line,j)=>line!==correct[j]);if(i>=0)lines[i]=correct[i];}
     save();return;
    }
    const checked=evaluate();assert.notEqual(checked.pid,process.pid,'Reviewer uses a separate process');
    const head=git('rev-parse','HEAD');
    const failures=phase==='review'&&initialReviewOnly.length?checked.failures.filter(f=>initialReviewOnly.some(id=>f.startsWith(id+':'))):checked.failures;
    const decision={phase,verdict:failures.length?'changes_requested':'pass',findings:failures.join('\n')||(phase==='review'&&initialReviewOnly.length?'Initial independent checks passed; final reviewer must inspect remaining frozen criteria.':'All frozen acceptance assertions passed.'),reviewedHeadSha:reviewMismatch?'f'.repeat(40):head};
    reviews.push({head,...decision,failures,pid:checked.pid});return decision;
   },
   commitCandidate:()=>{
    git('add','candidate.mjs');
    if(git('diff','--cached','--name-only'))git('commit','-qm','Synthetic candidate '+repairs);
    const head=git('rev-parse','HEAD');checkpoints.push(head);return head;
   },
   candidateIdentity:head=>git('rev-parse',head+'^{tree}'),
   verifyCandidate:async head=>{
    const checked=evaluate(),failures=checked.failures.filter(f=>!verifierOnly.length||verifierOnly.some(id=>f.startsWith(id+':')));
    const result={passed:failures.length===0,detail:failures.join('\n'),head};verifications.push(result);return result;
   },onCompleted:e=>{lastCompleted={...lastCompleted,...e};},onIteration:e=>trace.push(structuredClone(e))
  });}catch(e){error=e;}
  return {result,error,phases,reviews,verifications,trace,checkpoints,repairs,lastCompleted,source:readFileSync(source,'utf8'),accounting,initialAccounting};
 }finally{rmSync(root,{recursive:true,force:true});}
}

test('actual lifecycle completes three distinct legitimate repairs against immutable acceptance',async t=>{
 const f=await fixture();assert.ifError(f.error);assert.equal(f.result.repairIterations,3);
 assert.deepEqual(f.trace.map(x=>x.verification.passed),[false,false,true]);
 assert.deepEqual(f.reviews.map(x=>x.failures.length),[3,2,1,0]);
 assert.equal(new Set(f.checkpoints).size,4);assert.equal(new Set(f.trace.map(x=>x.sourceHash)).size,3);
 for(const cycle of f.trace){assert.equal(cycle.review.reviewedHeadSha,cycle.candidateHead);assert.equal(cycle.verification.head,cycle.candidateHead);}
 assert.equal(f.result.finalReview.verdict,'pass');assert.equal(f.result.candidateHead,f.checkpoints.at(-1));
 assert.equal(f.phases.filter(p=>p==='implementation').length,1);
 if(process.env.KATIE_ADAPTIVE_TRACE_FILE)writeFileSync(process.env.KATIE_ADAPTIVE_TRACE_FILE,JSON.stringify({qualification:'nonbillable-real-source-three-repairs',baseline:'43345347f6ea2b55c42d36fda9356db8f102a32d',frozenAcceptance:acceptance,finalSource:f.source,checkpoints:f.checkpoints,reviews:f.reviews,verifications:f.verifications,trace:f.trace,paidInferenceCalls:0},null,2)+'\n');
 t.diagnostic(JSON.stringify({qualification:'nonbillable-real-source-three-repairs',trace:f.trace.map(x=>({iteration:x.iteration,candidateHead:x.candidateHead,sourceHash:x.sourceHash,verification:x.verification.passed,verdict:x.review.verdict}))}));
});
test('first-pass candidate has no unnecessary repairs',async()=>{
 const f=await fixture({defects:[]});assert.ifError(f.error);assert.equal(f.repairs,0);assert.equal(f.verifications.length,1);assert.deepEqual(f.phases,['implementation','review','final-review']);
});
test('one source correction resolves all remaining findings',async()=>{
 const f=await fixture({defects:[1]});assert.ifError(f.error);assert.equal(f.repairs,1);assert.equal(f.result.finalReview.verdict,'pass');
});
test('passing deterministic subset cannot conceal independent failing acceptance',async()=>{
 const f=await fixture({defects:[1,2],verifierOnly:['total']});assert.ifError(f.error);assert.equal(f.repairs,2);assert.ok(f.verifications.every(v=>v.passed));assert.equal(f.reviews[0].verdict,'changes_requested');
});
test('previously resolved source defect reopens and is corrected',async()=>{
 const f=await fixture({repair:({lines,repairs,correct,broken})=>{
  if(repairs===1)lines[0]=correct[0];
  else if(repairs===2){lines[1]=correct[1];lines[0]=broken[0];}
  else {const i=lines.findIndex((line,j)=>line!==correct[j]);if(i>=0)lines[i]=correct[i];}
  return lines;
 }});
 assert.ifError(f.error);assert.equal(f.repairs,4);
 assert.ok(!f.reviews[1].failures.some(x=>x.startsWith('total:')));
 assert.ok(f.reviews[2].failures.some(x=>x.startsWith('total:')));
 assert.equal(f.result.finalReview.verdict,'pass');
});
test('unchanged candidate and unresolved findings stop ineffective repairs',async()=>{
 const f=await fixture({repair:({lines})=>lines});assert.match(f.error.message,/NO_PROGRESS/);assert.equal(f.repairs,1);assert.equal(f.checkpoints[0],f.checkpoints[1]);assert.equal(f.lastCompleted.stopReason,'no_meaningful_progress');
});
test('independent reviewer cannot approve a different source candidate',async()=>{
 const f=await fixture({defects:[],reviewMismatch:true});assert.match(f.error.message,/CANDIDATE_MISMATCH/);assert.equal(f.repairs,0);assert.equal(f.result,undefined);
});
test('resource admission denial preserves current source and does not repeat implementation',async()=>{
 const f=await fixture({denyRepair:n=>n===1});assert.match(f.error.message,/OWNER_APPROVAL_REQUIRED/);assert.equal(f.repairs,1);assert.equal(f.checkpoints.length,2);assert.equal(f.lastCompleted.adaptiveRepair.iteration,1);assert.ok(f.source.includes(correct[0]));assert.ok(f.source.includes(broken[1]));assert.equal(JSON.stringify(f.accounting),f.initialAccounting);assert.equal(f.phases.filter(p=>p==='implementation').length,1);
});

test('final independent review exposes real omitted defect and starts another repair cycle',async()=>{
 const f=await fixture({defects:[1],verifierOnly:['total'],initialReviewOnly:['total']});
 assert.ifError(f.error);assert.deepEqual(f.reviews.map(r=>r.verdict),['pass','changes_requested','pass']);
 assert.deepEqual(f.phases,['implementation','review','final-review','repair','final-review']);
 assert.equal(f.repairs,1);assert.equal(f.result.finalReview.reviewedHeadSha,f.result.candidateHead);
 // Execute the exact workflow predicate, not a rewritten test approximation.
 const workflow=readFileSync('.github/workflows/autonomous-development.yml','utf8');
 const marker=`jq -e --arg head "$TEST_HEAD" --arg project "$PROJECT_ID" '`;
 const start=workflow.indexOf(marker)+marker.length,end=workflow.indexOf(`' "$evidence"`,start);
 assert.ok(start>=marker.length&&end>start,'Real native completion gate must exist');
 const predicate=workflow.slice(start,end),head=f.result.candidateHead;
 const receipt={...f.result,version:1,metered:true,completed:true,projectId:'frozen-project',reviewedHeadSha:head};
 const accepted=value=>spawnSync('jq',['-e','--arg','head',head,'--arg','project','frozen-project',predicate],{input:JSON.stringify(value),encoding:'utf8'}).status===0;
 assert.equal(receipt.review.verdict,'pass','Initial independent verdict is retained');
 assert.equal(receipt.repairVerification,null,'This is a review-only defect, not failed deterministic evidence');
 assert.equal(accepted(receipt),true);
 for(const mutate of [
  value=>{delete value.reviewRepair;},
  value=>{delete value.reviewRepair.before;},
  value=>{delete value.reviewRepair.after;},
  value=>{value.reviewRepair.before.head=head;},
  value=>{value.reviewRepair.before.head='invalid';},
  value=>{value.reviewRepair.before.verdict='pass';},
  value=>{value.reviewRepair.after.head='f'.repeat(40);},
  value=>{value.finalReview.reviewedHeadSha='f'.repeat(40);}
 ]){const altered=structuredClone(receipt);mutate(altered);assert.equal(accepted(altered),false,'Malformed or cross-candidate repair evidence must not complete');}
});

test('capacity-paused repair resumes the same pending repair without a false no-progress denial',async()=>{
 let saved={},head='a'.repeat(40),denied=false;const phases=[];
 const options={qualifiedLifecycle:true,candidateIdentity:()=>head,
  commitCandidate:()=>head,verifyCandidate:async()=>({passed:head==='b'.repeat(40),detail:head==='a'.repeat(40)?'real failed check':''}),
  onCompleted:e=>{saved={...saved,...e};},runPhase:async phase=>{
   phases.push(phase);
   if(phase==='implementation')return;
   if(phase==='repair'){if(!denied){denied=true;throw Error('capacity pause');}head='b'.repeat(40);return;}
   return {phase,reviewedHeadSha:head,verdict:head==='a'.repeat(40)?'changes_requested':'pass',findings:head==='a'.repeat(40)?'Correct failing check':'Corrected check verified'};
  }};
 await assert.rejects(executeNativeDevelopmentLifecycle(options),/capacity pause/);
 const restored=structuredClone(saved),completedHead=head;
 const result=await executeNativeDevelopmentLifecycle({...options,recovery:{phase:'repair',completedCheckpointSha:completedHead,lastCompleted:restored,reviewFindings:'Correct failing check'}});
 assert.equal(result.finalReview.verdict,'pass');assert.equal(result.repairIterations,1);
 assert.deepEqual(phases,['implementation','review','repair','repair','final-review']);
});
test('interrupted repaired candidate verification reruns tests before source re-review',async()=>{
 let saved={},head='a'.repeat(40),verificationCalls=0,interrupted=false;const events=[];
 const options={qualifiedLifecycle:true,candidateIdentity:()=>head,commitCandidate:()=>head,
  onCompleted:e=>{saved={...saved,...e};},
  verifyCandidate:async()=>{events.push('verify:'+head);verificationCalls++;if(verificationCalls===2&&!interrupted){interrupted=true;throw Error('verifier interruption');}return {passed:head==='b'.repeat(40),detail:head==='a'.repeat(40)?'failing assertion':''};},
  runPhase:async phase=>{events.push(phase);if(phase==='implementation')return;if(phase==='repair'){head='b'.repeat(40);return;}return {phase,reviewedHeadSha:head,verdict:head==='a'.repeat(40)?'changes_requested':'pass',findings:head==='a'.repeat(40)?'Correct assertion':'Verified'};}
 };
 await assert.rejects(executeNativeDevelopmentLifecycle(options),/verifier interruption/);
 assert.equal(saved.verification.pending,true);
 const boundary=events.length;
 const result=await executeNativeDevelopmentLifecycle({...options,recovery:{phase:'final-review',completedCheckpointSha:head,lastCompleted:structuredClone(saved)}});
 assert.equal(result.finalReview.verdict,'pass');assert.deepEqual(events.slice(boundary),['verify:'+'b'.repeat(40),'final-review']);assert.equal(result.repairIterations,1);
});

test('completed candidate-bound final review is reused after interruption without any paid phase',async()=>{
 const head='a'.repeat(40),events=[];
 const result=await executeNativeDevelopmentLifecycle({recovery:{phase:'final-review',completedCheckpointSha:head,lastCompleted:{
  verification:{head,passed:true},review:{phase:'final-review',reviewedHeadSha:head,verdict:'pass',findings:'All frozen assertions passed'},
  initialReview:{phase:'review',reviewedHeadSha:'b'.repeat(40),verdict:'changes_requested',findings:'Original retained defect'},
  repairPerformed:true,adaptiveRepair:{version:2,nextAction:'complete',candidateHead:head,iteration:3,seen:[],stagnant:0}
 }},runPhase:async p=>{events.push(p);throw Error('Completed phase replayed');},verifyCandidate:async()=>{throw Error('Completed verification replayed');}});
 assert.equal(result.candidateHead,head);assert.equal(result.repairIterations,3);assert.deepEqual(events,[]);
 assert.equal(result.review.findings,'Original retained defect');
});
test('retained no-progress terminal decision cannot be cleared by runner restart',async()=>{
 await assert.rejects(executeNativeDevelopmentLifecycle({recovery:{phase:'repair',lastCompleted:{stopReason:'no_meaningful_progress'}},runPhase:()=>{throw Error('must not dispatch');}}),/NO_PROGRESS/);
});
test('pending verification preserves repair proof, iteration evidence and findings after interruption',async()=>{
 const head='b'.repeat(40),old='a'.repeat(40),iterations=[],events=[];
 const result=await executeNativeDevelopmentLifecycle({recovery:{phase:'review',completedCheckpointSha:head,lastCompleted:{
  repairPerformed:true,verification:{head,passed:false,pending:true},review:{phase:'final-review',reviewedHeadSha:old,verdict:'changes_requested',findings:'largest'},
  adaptiveRepair:{version:2,nextAction:'verification',candidateHead:head,iteration:3,seen:[],stagnant:1,failureSignature:'prior',pendingRepair:{iteration:3,before:{head:old,passed:false},source:'old-tree',priorFindings:['largest']}}
 }},candidateIdentity:()=> 'new-tree',verifyCandidate:async()=>{events.push('verify');return {passed:true,head};},runPhase:async phase=>{events.push(phase);return {phase,reviewedHeadSha:head,verdict:'pass',findings:'Frozen assertions passed'};},onIteration:e=>iterations.push(e)});
 assert.deepEqual(events,['verify','final-review']);assert.equal(iterations.length,1);assert.deepEqual(iterations[0].resolvedFindings,['largest']);assert.equal(result.repairVerification.before.head,old);assert.equal(result.repairVerification.after.head,head);
});
test('changed candidate cannot reuse a completed review',async()=>{
 await assert.rejects(executeNativeDevelopmentLifecycle({recovery:{phase:'final-review',completedCheckpointSha:'b'.repeat(40),lastCompleted:{verification:{passed:true},review:{reviewedHeadSha:'a'.repeat(40)},adaptiveRepair:{version:2,candidateHead:'b'.repeat(40),nextAction:'complete'}}}}),/CANDIDATE_MISMATCH/);
});
test('interrupted iteration bookkeeping reuses durable review without another model request',async()=>{
 let saved={},head='a'.repeat(40),interrupted=false;const events=[];
 const options={candidateIdentity:()=>head,commitCandidate:()=>head,onCompleted:e=>{saved=structuredClone(e);},
  verifyCandidate:async()=>({passed:head==='b'.repeat(40),detail:'frozen check'}),
  runPhase:async(phase)=>{events.push(phase);if(phase==='implementation')return;if(phase==='repair'){head='b'.repeat(40);return;}return {phase,reviewedHeadSha:head,verdict:head==='b'.repeat(40)?'pass':'changes_requested',findings:'Frozen check'};},
  onIteration:async()=>{if(!interrupted){interrupted=true;throw Error('bookkeeping interruption');}}
 };
 await assert.rejects(executeNativeDevelopmentLifecycle(options),/bookkeeping interruption/);
 assert.equal(saved.adaptiveRepair.nextAction,'complete');const before=events.length;
 const result=await executeNativeDevelopmentLifecycle({...options,recovery:{phase:'final-review',completedCheckpointSha:head,lastCompleted:saved}});
 assert.equal(result.finalReview.verdict,'pass');assert.equal(events.length,before);
});
test('completed stagnation threshold survives repair-phase recovery',async()=>{
 const head='a'.repeat(40);let requests=0;
 await assert.rejects(executeNativeDevelopmentLifecycle({recovery:{phase:'repair',completedCheckpointSha:head,lastCompleted:{verification:{head,passed:false},review:{phase:'final-review',reviewedHeadSha:head,verdict:'changes_requested',findings:'same failure'},adaptiveRepair:{version:2,nextAction:'repair',candidateHead:head,iteration:3,stagnant:3,seen:[]}}},runPhase:()=>{requests++;}}),/NO_PROGRESS/);
 assert.equal(requests,0);
});
test('interruption at each durable transition resumes only pending engineering',async()=>{
 for(let stop=1;stop<=12;stop++){
  let head='a'.repeat(40),saved,publications=0,stopped=false;const events=[];
  const options={candidateIdentity:()=>head,commitCandidate:()=>head,verifyCandidate:async()=>({passed:head==='b'.repeat(40),detail:'frozen assertion'}),
   runPhase:async phase=>{events.push(phase);if(phase==='implementation')return;if(phase==='repair'){head='b'.repeat(40);return;}return {phase,reviewedHeadSha:head,verdict:head==='a'.repeat(40)?'changes_requested':'pass',findings:'frozen assertion'};},
   onCompleted:e=>{saved=structuredClone(e);if(++publications===stop){stopped=true;throw Error('durable transition interruption');}}
  };
  let result;try{result=await executeNativeDevelopmentLifecycle(options);}catch(error){assert.match(error.message,/durable transition interruption/);}
  if(stopped){const action=saved.adaptiveRepair.nextAction;result=await executeNativeDevelopmentLifecycle({...options,onCompleted:()=>{},recovery:{phase:action==='repair'?'repair':action==='verification'?'review':'final-review',completedCheckpointSha:head,lastCompleted:saved,reviewFindings:saved.review?.findings}});}
  assert.equal(result.finalReview.verdict,'pass');assert.equal(events.filter(p=>p==='implementation').length,1);assert.equal(events.filter(p=>p==='repair').length,1);assert.equal(events.filter(p=>p==='review').length,1);assert.equal(events.filter(p=>p==='final-review').length,1);
 }
});
