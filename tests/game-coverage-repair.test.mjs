import test from 'node:test';
import assert from 'node:assert/strict';
import {gameCoverageRepair} from '../lib/projects/game-coverage-repair.mjs';
test('coverage diagnostics enumerate missing approved rule IDs without inventing gameplay',()=>{
 const plan={game:{rules:{rules:[
  {id:'r1',status:'verified',description:'Take one stone',category:'action',sourceIds:['user']},
  {id:'r2',status:'verified',description:'Reset',category:'reset',sourceIds:['user']},
  {id:'r14',status:'approved_interpretation',description:'Malformed persistence guard',category:'persistence',sourceIds:['user']},
  {id:'r15',status:'unresolved',description:'Requires a decision',category:'other',sourceIds:['user']}
 ],unknowns:[{id:'u1',status:'open',blocking:true,question:'Which behavior?',ruleIds:['r15']} ]},
 acceptance:{scenarios:[{id:'take-one',ruleIds:['r1'],steps:[{action:{type:'take',count:1},expectedState:{stones:10}}]}]}}};
 const original=structuredClone(plan),result=gameCoverageRepair(plan);
 assert.deepEqual(result.missingRuleIds,['r2','r14']);
 assert.equal(result.mayAutoApprove,false);
 assert.equal(result.requiredCoverage[1].ruleId,'r14');
 assert.deepEqual(result.blockingUnknowns.map(u=>u.id),['u1']);
 assert.deepEqual(plan,original,'no invented assertions or mutated original');
 assert.match(result.instructions,/independent review/);
});
test('missing coverage never treated as authorization to add empty or fake test references',()=>{
 const result=gameCoverageRepair({game:{rules:{rules:[{id:'r1',status:'verified',description:'victory',category:'victory',sourceIds:['user']}],unknowns:[]},acceptance:{scenarios:[]}}});
 assert.deepEqual(result.missingRuleIds,['r1']);
 assert.equal(result.existingScenarioIds.length,0);
 assert.equal(result.mayAutoApprove,false);
});
