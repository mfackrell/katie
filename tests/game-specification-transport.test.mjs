import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {modules} from './helpers/load-project-modules.mjs';
import {gameFixture} from './fixtures/game-project.mjs';
const load=modules(),transport=load('@/lib/projects/game-specification-transport');
function compact(){const f=gameFixture();return {specificationFormat:'registered-game-v1',name:'Counter',summary:'A controlled counter',requirements:['Increment and reject invalid actions'],allowedPaths:f.allowedPaths,milestones:[{title:'Complete game',instruction:'Build every approved rule'}],finalContract:{path:f.contract.path},game:f.game};}
test('single-source game wire format expands exactly to existing registered contracts',()=>{
 const wire=compact(),plan=transport.validateGameSpecificationResponse(JSON.stringify(wire));
 assert.deepEqual(JSON.parse(JSON.stringify(plan.finalContract.scenarios)),wire.game.acceptance.scenarios.filter(s=>s.kind==='browser').map(s=>({name:s.id,steps:s.steps})));
 assert.equal(JSON.stringify(plan.milestones[0].contract),JSON.stringify(plan.finalContract));
 assert.deepEqual(JSON.parse(JSON.stringify(transport.validateGameSpecificationResponse(transport.compactValidatedGameSpecification(JSON.stringify(plan))))),JSON.parse(JSON.stringify(plan)));
});
test('wire format never silently fixes contradictory duplicate contracts or missing coverage',()=>{
 const wire=compact();wire.finalContract.scenarios=[];
 assert.throws(()=>transport.validateGameSpecificationResponse(JSON.stringify(wire)),/Compact/);
 const bad=compact();bad.game.acceptance.scenarios=[];
 assert.throws(()=>transport.validateGameSpecificationResponse(JSON.stringify(bad)));
});
test('targeted exact repair preserves other content and revalidates the complete candidate',()=>{
 const wire=compact();wire.summary='An incorrect summary';const base=JSON.stringify(wire);
 const patch=JSON.stringify({edits:[{before:'An incorrect summary',after:'A controlled counter'}],composerNotes:''});
 const repaired=transport.repairGameSpecification(base,transport.specificationTextHash(base),patch);
 assert.equal(repaired.plan.summary,'A controlled counter');
 assert.equal(repaired.text,base.replace('An incorrect summary','A controlled counter'));
 assert.throws(()=>transport.repairGameSpecification(base,'0'.repeat(64),patch),/base changed/);
 assert.throws(()=>transport.repairGameSpecification(base,transport.specificationTextHash(base),JSON.stringify({edits:[{before:'not in original',after:'invented'}],composerNotes:''})),/exactly one/);
});
test('actual worker archives raw draft and validation before failing, then requests only targeted repair',async()=>{
 const lead=randomUUID(),m={id:randomUUID(),project_id:randomUUID(),objective:'Create the original counter with all tests',status:'running',project_kind:'specification',project_evidence:{projectProfile:'game',specificationBudget:{version:2}},team:[{id:lead,config:{instructions:'Implement requirements only'}}]};
 const j={id:randomUUID(),mission_id:m.id,role:'compose',job_key:'compose',agent_id:lead,attempts:1,lease:randomUUID(),payload:{},result:null,dependencies:[],instruction:'Produce specification'};
 const calls=[];
 const runtime=modules({'@/lib/missions/inspection':{workflowInspection:async()=>null},'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[j]}),rpc:async(name,args)=>{calls.push({name,args});return true;}}});
 const worker=runtime('@/lib/missions/worker'),bad=compact();bad.summary='';const raw=JSON.stringify(bad);
 let failure;
 try{await worker.executeClaim({mission:m,job:j},async(_,instruction)=>{assert.match(instruction,/COMPACT SERIALIZATION/);return{text:raw};});}catch(e){failure=e;}
 assert.ok(failure);assert.equal(calls[0].name,'checkpoint_mission_specification_draft');assert.equal(calls[0].args.p_response,raw);assert.ok(calls[0].args.p_validation);assert.equal(calls.length,1);
 j.result=failure.partial;j.attempts=2;calls.length=0;
 await worker.executeClaim({mission:m,job:j},async(claim,instruction,input)=>{
  assert.match(instruction,/TARGETED SPECIFICATION REPAIR/);const context=JSON.parse(input);assert.equal(context.candidate.text,raw);
  assert.equal(claim.job.payload.specificationPatchBaseHash,transport.specificationTextHash(raw));
  return {text:JSON.stringify({edits:[{before:'"summary":""',after:'"summary":"A controlled counter"'}],composerNotes:''})};
 });
 assert.deepEqual(calls.map(x=>x.name),['checkpoint_mission_specification_draft','commit_mission_work']);
 assert.equal(calls[1].args.p_mission_status,null,'Valid specification still requires independent review');
 assert.equal(JSON.parse(calls[1].args.p_result.text).summary,'A controlled counter');
});
