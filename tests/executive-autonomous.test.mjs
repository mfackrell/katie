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
const {financeDelegationIntent,developmentDelegationIntent,startExecutiveDevelopment}=exports;
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
test('ordinary app requests and unrelated content stay with existing project router',()=>{
 for(const text of [
  'Build a new dashboard for my invoices.',
  'Review our software architecture and suggest improvements.',
  'Delegate software development.',
  'Analyze financial statements and cash flow.',
  'Create a specialist orchestrator for operations.'
 ])assert.equal(developmentDelegationIntent(text),false,text);
});

// Padding must not turn an unfinished cue into a delegated objective. Some
// cases deliberately exceed the router's minimum length without adding work.
const incompleteDevelopmentRequests=[
 'Delegate software development',
 'Delegate software development to',
 'Delegate software development to   ...?!',
 '  Delegate software development   ...?!  ',
 'Delegate this software development.',
 'Delegate\tsoftware\tdevelopment\tto\t...?!',
 'Delegate software development\n to\n ...?!',
 'Have the software development agent implement',
 'Have the development orchestrator build   ...?!',
 'Please have the software development agent fix   ...?!',
 'Executive: update',
 'Executive: implement                 ...?!',
];

test('unfinished development cues remain ordinary chat',async(t)=>{
 for(const message of incompleteDevelopmentRequests){
  await t.test(JSON.stringify(message),()=>{
   assert.equal(developmentDelegationIntent(message),false);
  });
 }
});

test('unfinished development cues never enter the development workflow',async(t)=>{
 // The VM provides no database client. Returning null proves the entry point
 // exits before repository checks, registry lookups, or mission creation.
 for(const message of incompleteDevelopmentRequests){
  await t.test(JSON.stringify(message),async()=>{
   assert.equal(await startExecutiveDevelopment({
    actorId:'actor-regression',chatId:'chat-regression',
    requestId:'request-regression',activeRepoId:'repo-regression',message,
   }),null);
  });
 }
});

test('complete delegated development objectives still route with whitespace and punctuation',()=>{
 for(const message of [
  '  Delegate software development to fix the checkout integration tests.  ',
  'Please delegate this software development to add regression tests for the Executive router.',
  'Have the development orchestrator build an invoice export endpoint.',
  'Please have the software development agent fix the failing checkout tests.',
  '\nExecutive: implement an audit logging endpoint.\t',
 ])assert.equal(developmentDelegationIntent(message),true,message);
});
