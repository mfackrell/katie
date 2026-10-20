import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const src=readFileSync('lib/executive/management.ts','utf8');
const transpiled=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function scenario(kind='executive'){
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
  throw Error('Unexpected dependency '+name);
 }});
 return{run:exports.handleExecutiveManagement,writes};
}
const input={actorId:'eo',chatId:'chat',requestId:'req-1',message:'# Executive Assignment: Comprehensive Independent Audit of Katie\n\nInvestigate the entire platform and create specialist autonomous workflows.'};
test('unsupported real Executive assignment is durably BLOCKED, never answered or completed',async()=>{
 const x=scenario();
 const answer=await x.run(input);
 assert.match(answer,/BLOCKED/);
 assert.match(answer,/NOT performed the assignment/);
 assert.equal(x.writes.filter(w=>w.kind==='insert').length,1);
 const recorded=x.writes.find(w=>w.kind==='update');
 assert.equal(recorded.row.status,'blocked');
 assert.equal(recorded.row.detail,answer);
});
test('standard Katie actor cannot invoke the Executive management plane',async()=>{
 const x=scenario('standard');
 await assert.rejects(()=>x.run(input),/dedicated executive identity/);
 assert.equal(x.writes.length,0);
});
