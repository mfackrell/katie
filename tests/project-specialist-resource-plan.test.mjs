import test from 'node:test';
import assert from 'node:assert/strict';
import {provisionalSpecialistPlan,reconcileSpecialistEstimates} from '../lib/projects/specialist-resource-plan.mjs';
const scope={totals:{expectedTokens:110},workPackages:[
{id:'backend_data',lowerTokens:30,estimatedTokens:50,upperTokens:90,estimateBasis:'Data migrations'},
{id:'testing_debugging',lowerTokens:40,estimatedTokens:60,upperTokens:100,estimateBasis:'Acceptance testing'}]};
test('reconciles a scope-based plan without changing spending authorization',()=>{
 const p=provisionalSpecialistPlan(scope);
 assert.equal(p.totals.expectedTokens,110);
 assert.equal(p.spendingAuthorization,'unchanged');
 assert.equal(p.independentlySubmitted,false);
 assert.equal(p.assignments.length,2);
});
test('specialists may revise estimates but cannot overlap or omit ownership',()=>{
 const proposals=[
{specialist:'backend',origin:'specialist_verified',packages:[{packageId:'backend_data',lowerTokens:40,expectedTokens:80,upperTokens:120,basis:'API complexity',dependencies:[]}]},
{specialist:'review',origin:'specialist_verified',packages:[{packageId:'testing_debugging',lowerTokens:40,expectedTokens:60,upperTokens:100,basis:'Tests',dependencies:['backend_data']}]}
 ];
 const revised=reconcileSpecialistEstimates(scope,proposals);
 assert.equal(revised.varianceTokens,30);
 assert.equal(revised.independentlySubmitted,true);
 assert.throws(()=>reconcileSpecialistEstimates(scope,[...proposals,proposals[0]]),/Overlapping/);
 assert.throws(()=>reconcileSpecialistEstimates(scope,proposals.slice(0,1)),/Unestimated/);
});

test('provisional dependencies reference only in-scope packages',()=>{
 const plan=provisionalSpecialistPlan(scope);
 const names=new Set(scope.workPackages.map(p=>p.id));
 for(const assignment of plan.assignments)
  assert.ok(assignment.dependencies.every(dep=>names.has(dep)));
 assert.deepEqual(plan.assignments.find(a=>a.packageId==='testing_debugging').dependencies,['backend_data']);
});
