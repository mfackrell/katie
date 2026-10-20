import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function load(path,overrides={}){
 const source=readFileSync(path,'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const exports={};
 vm.runInNewContext(js,{exports,require:name=>overrides[name]??require(name)});
 return exports;
}
const catalog=load('lib/executive/mission-catalog.ts');
const contracts=load('lib/executive/contracts.ts');
const provisioning=load('lib/executive/provisioning.ts',{'./contracts':contracts});
const agents=[
 {config:{name:'Mission Lead',research:false}},
 {config:{name:'Analysis Agent',research:false}},
 {config:{name:'Research Agent',research:true}},
];
const requirement={
 capability:'operations_analysis',objective:'Deliver bounded operating analysis',
 successCriteria:['Verified objective and acceptance'],
 proposedSlug:'operations',proposedTitle:'Operations Orchestrator',
 proposedDescription:'Read-only operations analysis with independently reviewed results',
 proposedCapabilities:['operations_analysis']
};
test('an existing saved team supplies a bounded catalog independent of active specialists',()=>{
 const supported=Array.from(catalog.verifiedMissionCatalog(agents));
 assert.deepEqual(supported,['financial_analysis','operations_analysis','research_synthesis']);
 assert.equal(provisioning.decideProvisioning(requirement,[],supported).route,'configure');
});
test('no verified research agent means no catalog or fabricated specialist',()=>{
 const supported=Array.from(catalog.verifiedMissionCatalog(agents.slice(0,2)));
 assert.deepEqual(supported,[]);
 assert.equal(provisioning.decideProvisioning(requirement,[],supported).route,'commission');
});
test('unimplemented specialties are always commissioned and cannot be configured',()=>{
 const supported=Array.from(catalog.verifiedMissionCatalog(agents));
 const req={...requirement,capability:'logistics_coordination',proposedSlug:'logistics',proposedCapabilities:['logistics_coordination']};
 const outcome=provisioning.decideProvisioning(req,[],supported);
 assert.equal(outcome.route,'commission');
 assert.deepEqual(Array.from(outcome.missingCapabilities),['logistics_coordination']);
});
test('matching active specialist is reused ahead of creating a duplicate',()=>{
 const supported=Array.from(catalog.verifiedMissionCatalog(agents));
 assert.equal(provisioning.decideProvisioning(requirement,[
  {id:'one',slug:'operations',capabilities:['operations_analysis'],status:'active',adapter:'mission',endpoint_key:null}
 ],supported).route,'reuse');
});
