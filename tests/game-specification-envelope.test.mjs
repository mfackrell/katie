import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const src=readFileSync('lib/missions/request-budget.ts','utf8');
const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exported={};
vm.runInNewContext(js,{exports:exported,require:()=>({}),Date});
test('game specification reviews receive a bounded phase-aware source envelope',()=>{
 const claim={mission:{project_kind:'specification',project_evidence:{projectProfile:'game'}},job:{role:'review'}};
 assert.equal(exported.missionInputLimit(claim),96000);
 assert.equal(exported.fitsMissionEnvelope('instruction','a'.repeat(60000),exported.missionInputLimit(claim)),true);
 assert.equal(exported.fitsMissionEnvelope('instruction','a'.repeat(96001),exported.missionInputLimit(claim)),false);
 assert.equal(exported.fitsMissionEnvelope('a'.repeat(48001),'source',exported.missionInputLimit(claim)),false);
 for(const role of ['compose','revise'])assert.equal(exported.missionInputLimit({...claim,job:{role}}),96000);
 for(const kind of ['development','assessment'])assert.equal(exported.missionInputLimit({...claim,mission:{...claim.mission,project_kind:kind}}),48000);
 assert.equal(exported.missionInputLimit({...claim,mission:{...claim.mission,project_evidence:null}}),48000);
 assert.equal(exported.missionInputLimit({...claim,job:{role:'work'}}),48000);
});
test('model and review worker both use mission specific admission without changing token reservations',()=>{
 const model=readFileSync('lib/missions/model.ts','utf8');
 const worker=readFileSync('lib/missions/worker.ts','utf8');
 assert.ok(model.includes('fitsMissionEnvelope(instruction,input,missionInputLimit(claim))'));
 assert.ok(worker.includes('fitsMissionEnvelope(reviewFrame,reviewInput,missionInputLimit(claim))'));
 assert.ok(model.includes('reserve_mission_routing_call'));
 assert.ok(model.includes('finish_mission_call'));
});
