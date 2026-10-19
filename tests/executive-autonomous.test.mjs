import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const file=readFileSync(resolve('lib/executive/autonomous.ts'),'utf8');
const js=ts.transpileModule(file,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exports={};
vm.runInNewContext(js,{exports,require:(name)=>{
 if(name==='node:crypto')return{createHash:()=>({update:()=>({digest:()=>('a'.repeat(64))})})};
 return {};
}});
const {financeDelegationIntent,developmentDelegationIntent}=exports;
test('routes explicit finance-analysis work only',()=>{
 for(const text of [
  'Analyze the company financial statements and recommend corrective actions.',
  'Review quarterly revenue, COGS and profitability based on the figures provided.',
  'Assess cash flow performance and identify three operating concerns.'
 ])assert.equal(financeDelegationIntent(text),true,text);
});
test('does not steal ordinary chat, operations, software, or privileged requests',()=>{
 for(const text of [
  'How is the weather today?',
  'Build a finance dashboard in my software project.',
  'Analyze financial results and email the report to our customer.',
  'Create a finance orchestrator.',
  'Review the financial code and deploy fixes to production.',
  'Analyze revenue and change the database records.',
  'Analyze cash flow.',
 ])assert.equal(financeDelegationIntent(text),false,text);
});

test('explicit Executive software development requests delegate to existing specialist',()=>{
 for(const text of [
  'Delegate software development to fix the failing checkout integration tests.',
  'Have the software development agent implement a secure audit logging endpoint.',
  'Executive: update the application to display mission review status.'
 ])assert.equal(developmentDelegationIntent(text),true,text);
});
test('incomplete coding delegation stays rejected with trailing whitespace or punctuation',()=>{
 for(const suffix of ['', '   ', '\t\n', '.', '!', '?', ':', ';', ',', '...   ', '.\t\n']){
  const incomplete='Delegate software development'+suffix;
  assert.equal(developmentDelegationIntent(incomplete),false,JSON.stringify(incomplete));
  const complete='Delegate software development to fix the failing checkout integration tests'+suffix;
  assert.equal(developmentDelegationIntent(complete),true,JSON.stringify(complete));
 }
});
test('ordinary app requests and unrelated content stay with existing project router',()=>{
 for(const text of [
  'Build a new dashboard for my invoices.',
  'Review our software architecture and suggest improvements.',
  'Delegate software development.',
  'Analyze financial statements and cash flow.',
  'Create a specialist orchestrator for operations.'
 ])assert.equal(developmentDelegationIntent(text),false,text);
});
