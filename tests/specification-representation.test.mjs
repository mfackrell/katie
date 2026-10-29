import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {modules} from './helpers/load-project-modules.mjs';
import {gameFixture} from './fixtures/game-project.mjs';
const fixture=JSON.parse(readFileSync('tests/fixtures/specification-representation-failure.json','utf8'));
const load=modules(),transport=load('@/lib/projects/game-specification-transport'),recovery=load('@/lib/projects/specification-recovery');
const plan=transport.validateGameSpecificationResponse(fixture.candidate);
const plain=x=>JSON.parse(JSON.stringify(x));
test('saved normalization/review/revision failure reproduces without weakening the change guard',()=>{
 const patch=JSON.parse(fixture.rejectedPatch);
 assert.equal(patch.edits.reduce((n,e)=>n+e.after.length-e.before.length,0),4680);
 assert.throws(()=>transport.repairGameSpecification(fixture.candidate,transport.specificationTextHash(fixture.candidate),fixture.rejectedPatch),/changed too much/);
 const evidence=recovery.specificationCandidateEvidence({text:JSON.stringify(plan)});
 assert.equal(evidence.specification.specificationFormat,'registered-game-v1');
 assert.deepEqual(Object.keys(evidence.specification.finalContract),['path']);
 assert.deepEqual(Object.keys(evidence.specification.milestones[0]).sort(),['instruction','title']);
 assert.deepEqual(plain(transport.validateGameSpecificationResponse(JSON.stringify(evidence.specification))),plain(plan));
 assert.equal(evidence.fullSpecificationHash,load('@/lib/projects/contract').digest(plan));
 assert.ok(evidence.specification.game.acceptance.scenarios.every(s=>Array.isArray(s.steps)));
 assert.match(evidence.referenceNote,/neither normalization nor structural validation establishes semantic approval/);
});
test('normalization rejects contradictory duplicate browser assertions',()=>{
 const distinct=plain(plan);distinct.finalContract.scenarios[0].name='distinct-browser-name';
 distinct.milestones[0].contract=structuredClone(distinct.finalContract);
 const text=JSON.stringify(distinct);
 assert.throws(()=>transport.compactValidatedGameSpecification(text),/exactly execute registered/);
});
test('multi-milestone review retains its bounded lossless view and every unique contract',()=>{
 const f=gameFixture();
 f.game.acceptance.scenarios[1].steps=Array.from({length:60},()=>({action:'expectText',selector:'#count',value:'1'.repeat(200)}));
 const contract={path:'/counter',scenarios:[{name:'browser',steps:f.game.acceptance.scenarios[1].steps}]};
 const candidate={name:'Counter',summary:'Counter',requirements:['Increment'],allowedPaths:f.allowedPaths,game:f.game,finalContract:contract,
  milestones:Array.from({length:6},(_,i)=>({title:'Stage '+i,instruction:'Verify counter',contract:structuredClone(contract)}))};
 candidate.milestones[0].contract={path:'/counter',scenarios:[{name:'intermediate',steps:[{action:'expectText',selector:'#count',value:'0'}]}]};
 load('@/lib/projects/contract').validateProjectPlan(candidate);
 assert.ok(JSON.stringify(candidate).length>96000,'Expanded repeated contracts exceed review input envelope');
 const evidence=recovery.specificationCandidateEvidence({text:JSON.stringify(candidate)});
 assert.ok(JSON.stringify(evidence).length<24000,'Validated lossless view remains bounded');
 assert.deepEqual(plain(evidence.specification.milestones[0].contract),candidate.milestones[0].contract);
 assert.equal(evidence.specification.milestones[1].contractRef,'finalContract');
 assert.deepEqual(plain(evidence.specification.finalContract),contract);
 assert.match(evidence.specification.game.acceptance.scenarios[1].stepsRef,/finalContract/);
 assert.equal(evidence.fullSpecificationHash,load('@/lib/projects/contract').digest(candidate));
});
test('real worker retains historical findings, repairs substantive coverage and requires independent re-review',async()=>{
 const lead=randomUUID(),reviewer=randomUUID();
 const mission={id:randomUUID(),project_id:randomUUID(),objective:'Original Take Eleven: illegal moves preserve full state. '+transport.COMPACT_GAME_INSTRUCTION,status:'running',project_kind:'specification',team:[{id:lead,config:{instructions:'Specify original game only'}},{id:reviewer,config:{instructions:'Independently verify every rule'}}],project_evidence:{projectProfile:'game',specificationBudget:{version:2},specificationRecovery:{priorReviews:[{sourceJobId:randomUUID(),...fixture.review}]}}};
 const make=(role,key)=>({id:randomUUID(),mission_id:mission.id,role,job_key:key,agent_id:role==='review'?reviewer:lead,status:'running',instruction:'Verify original requirements',dependencies:[],payload:{},attempts:1,lease:randomUUID(),result:null});
 const compose={...make('compose','compose'),status:'completed',result:{text:JSON.stringify(plan)}},review=make('review','review');
 const jobs=[compose,review],calls=[];
 const runtime=modules({'@/lib/missions/inspection':{workflowInspection:async()=>null},'@/lib/missions/store':{readMission:async()=>({mission,jobs}),rpc:async(name,args)=>{calls.push({name,args});return true;}}});
 const worker=runtime('@/lib/missions/worker'),ids=runtime('@/lib/projects/completion').PROJECT_ACCEPTANCE_IDS;
 const verdict=pass=>({text:JSON.stringify({verdict:pass?'approve':'revise',findings:pass?'Verified explicit insufficient-stones invariant against the original rule.':'Missing model assertion for a permitted take value exceeding the remaining nonterminal stones.',checks:ids.map(id=>({id,passed:pass||id!=='criterion:1',evidence:'Checked original rule and explicit model steps for insufficient stones.'}))}),model:'offline-review-fixture',sources:[],calculations:[]});
 await worker.executeClaim({mission,job:review},async(claim,instruction,input)=>{
  assert.equal(claim.job.agent_id,reviewer);assert.match(instruction,/Composition serialization instructions are transport rules/);
  const payload=JSON.parse(input.split('Evidence and candidate:\n')[1]);
  assert.equal(payload.candidate.result.specification.specificationFormat,'registered-game-v1');
  assert.ok(payload.priorFindings.some(r=>r.findings.some(f=>f.includes('compact serialization'))));
  return verdict(false);
 });
 const first=calls.at(-1).args;assert.equal(first.p_children[0].key,'revision');assert.match(first.p_children[0].instruction,/insufficient|exceeding/);
 review.status='completed';review.result=first.p_result;
 const revision={...make('revise','revision'),instruction:first.p_children[0].instruction};jobs.push(revision);
 // A prior failed patch left a structurally valid base. It must still be repaired,
 // not automatically committed unchanged because canonical validation passes.
 revision.result={rejectedSpecification:fixture.candidate,specificationPatchFeedback:'Targeted revision changed too much content'};
 const base=fixture.candidate,parsed=JSON.parse(base),scenario=structuredClone(parsed.game.acceptance.scenarios.find(s=>s.id==='model-legal-take-3'));
 scenario.id='model-insufficient-stones';scenario.description='A legal take value exceeding remaining stones preserves every state field.';
 scenario.ruleIds=['r-legal-take-conditions','r-invalid-noop'];
 scenario.steps=[{action:{type:'TAKE',count:3},expectedState:{stones:8,activePlayer:'B',phase:'IN_PROGRESS',winner:null}},{action:{type:'TAKE',count:3},expectedState:{stones:5,activePlayer:'A',phase:'IN_PROGRESS',winner:null}},{action:{type:'TAKE',count:3},expectedState:{stones:2,activePlayer:'B',phase:'IN_PROGRESS',winner:null}},{action:{type:'TAKE',count:3},expectedState:{stones:2,activePlayer:'B',phase:'IN_PROGRESS',winner:null}}];
 const before='"scenarios":[',after=before+JSON.stringify(scenario)+',';
 let repairs=0;
 await worker.executeClaim({mission,job:revision},async(_,instruction,input)=>{
  repairs++;assert.match(instruction,/TARGETED SPECIFICATION REPAIR/);const payload=JSON.parse(input);assert.equal(payload.candidate.text,base);assert.match(input,/insufficient stones/);
  return {text:JSON.stringify({edits:[{before,after}],composerNotes:''}),sources:[],calculations:[],model:'offline-patch-fixture'};
 });
 assert.equal(repairs,1);assert.equal(calls.at(-1).args.p_mission_status,null);assert.equal(calls.at(-1).args.p_final,null);
 revision.status='completed';revision.result=calls.at(-1).args.p_result;
 assert.equal(revision.result.revisionPatch.baseHash,transport.specificationTextHash(base));
 assert.equal(revision.result.specificationNormalization.independentReviewRequired,true);
 assert.equal(calls.at(-2).name,'checkpoint_mission_specification_draft');
 const again=make('review','review_again');jobs.push(again);
 await worker.executeClaim({mission,job:again},async(_,instruction,input)=>{
  const payload=JSON.parse(input.split('Evidence and candidate:\n')[1]);
  assert.ok(payload.candidate.result.specification.game.acceptance.scenarios.some(s=>s.id==='model-insufficient-stones'));
  assert.ok(payload.priorFindings.some(r=>JSON.stringify(r).includes('insufficient stones')));
  return verdict(true);
 });
 assert.equal(calls.at(-1).args.p_mission_status,'completed');
 assert.equal(calls.at(-1).args.p_final,revision.result.text);
 assert.equal(compose.result.text,JSON.stringify(plan),'Original composition preserved');
});
