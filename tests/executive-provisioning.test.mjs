import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const modules={};
for(const file of ['contracts','provisioning']){
 const js=ts.transpileModule(readFileSync('lib/executive/'+file+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const exports={};
 vm.runInNewContext(js,{exports,require:name=>name==='./contracts'?modules.contracts:require(name),console},{filename:file});
 modules[file]=exports;
}
const proposed={capability:'financial_analysis',objective:'Build a financial analysis specialist',
 successCriteria:['Correct financial statements and supported decisions'],
 proposedSlug:'finance',proposedTitle:'Finance Specialist',
 proposedDescription:'Financial analysis and reporting coordination',
 proposedCapabilities:['financial_analysis','management_reporting']};
test('executive provisioning reuses an active specialist before building anything',()=>{
 const r=modules.provisioning.decideProvisioning(proposed,[
 {id:'ready',slug:'finance',capabilities:['financial_analysis'],status:'active',adapter:'external',endpoint_key:'finance_api'},
 {id:'inactive',slug:'other',capabilities:['financial_analysis'],status:'registered',adapter:'mission',endpoint_key:null}
 ],[]);
 assert.equal(r.route,'reuse');assert.equal(r.specialistId,'ready');
});
test('existing capabilities configure instead of requesting software development',()=>{
 const r=modules.provisioning.decideProvisioning(proposed,[],['management_reporting','financial_analysis']);
 assert.equal(r.route,'configure');assert.equal(r.specialistSlug,'finance');
});
test('missing capabilities commission specialized construction instead of inventing tools',()=>{
 const r=modules.provisioning.decideProvisioning(proposed,[],['financial_analysis']);
 assert.equal(r.route,'commission');assert.deepEqual(Array.from(r.missingCapabilities),['management_reporting']);
});
test('inactive specialists cannot be silently reused and malformed capability contracts fail',()=>{
 assert.equal(modules.provisioning.decideProvisioning(proposed,[
 {id:'inactive',slug:'finance',capabilities:['financial_analysis'],status:'disabled',adapter:'mission',endpoint_key:null}
 ],[]).route,'commission');
 assert.throws(()=>modules.provisioning.decideProvisioning({...proposed,proposedCapabilities:['financial_analysis','financial_analysis']},[],[]));
 assert.throws(()=>modules.provisioning.decideProvisioning({...proposed,proposedCapabilities:['management_reporting']},[],[]));
});