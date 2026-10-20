import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const src=readFileSync('lib/executive/management.ts','utf8');
const transpiled=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function scenario(kind='executive'){
 const generalCalls=[];
 const writes=[];
 const db={
  from(table){
   const q={
    select(){return this;},eq(){return this;},
    async maybeSingle(){
     if(table==='actors')return {data:{actor_kind:kind},error:null};
     if(table==='chats')return {data:{actor_id:'eo'},error:null};
     if(table==='executive_management_requests')return {data:null,error:null};
     throw Error('Unexpected table '+table);
    },
    async insert(row){writes.push({table,kind:'insert',row});return{error:null};},
    async update(row){writes.push({table,kind:'update',row});return{error:null};}
   };
   return q;
  }
 };
 const exports={};
 vm.runInNewContext(transpiled,{exports,require(name){
  if(name==='@/lib/data/supabase/admin')return{getSupabaseAdminClient:()=>db};
  if(name==='./intake')return{handleExecutiveSpecialistIntake:async()=>null};
  if(name==='./factory-runtime')return{startSpecialistAssignment:async()=>null};
  if(name==='./autonomous')return{startExecutiveFinance:async()=>null,startExecutiveDevelopment:async()=>null};
  if(name==='./general')return{startGeneralExecutiveManagement:async input=>{generalCalls.push(input);return 'Executive objective registered. Autonomous specialist missions started: 2.';}};
  throw Error('Unexpected dependency '+name);
 }});
 return{run:exports.handleExecutiveManagement,writes,generalCalls};
}
const input={actorId:'eo',chatId:'chat',requestId:'req-1',message:'# Executive Assignment: Comprehensive Independent Audit of Katie\n\nInvestigate the entire platform and create specialist autonomous workflows.'};
test('general Executive assignment enters autonomous planner, never ordinary chat',async()=>{
 const x=scenario();
 const answer=await x.run(input);
 assert.match(answer,/Autonomous specialist missions started: 2/);
 assert.equal(x.writes.filter(w=>w.kind==='insert').length,1);
 assert.equal(x.generalCalls.length,1);
 assert.equal(x.generalCalls[0].message,input.message);
 assert.equal(x.writes.some(w=>w.kind==='update'),false); // Planner owns the plan transitions.
});
test('standard Katie actor cannot invoke the Executive management plane',async()=>{
 const x=scenario('standard');
 await assert.rejects(()=>x.run(input),/dedicated executive identity/);
 assert.equal(x.writes.length,0);
});
