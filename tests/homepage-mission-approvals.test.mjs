import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const code=ts.transpileModule(readFileSync(resolve('app/api/missions/pending/route.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;

function route(missions,jobs,failedTable=null){
 const fakeClient={
  from(table){
   const builder={
    select(){return this;},eq(){return this;},in(){return this;},limit(){return this;},order(){return this;},
    async returns(){return failedTable===table?{data:null,error:{message:'unavailable'}}:
      {data:table==='agent_missions'?missions:jobs,error:null};}
   };
   return builder;
  }
 };
 const output={};
 vm.runInNewContext(code,{
  exports:output,
  require:name=>{
   if(name==='next/server')return{NextResponse:{json:(body,options={})=>({body,status:options.status??200,headers:options.headers})}};
   if(name==='@/lib/data/supabase/admin')return{getSupabaseAdminClient:()=>fakeClient};
   return {};
  },
 });
 return output.GET;
}

test('main Katie page displays the global coding approval surface',()=>{
 const page=readFileSync(resolve('app/page.tsx'),'utf8');
 const card=readFileSync(resolve('components/pending-mission-approvals.tsx'),'utf8');
 assert.match(page,/<PendingMissionApprovals\s*\/>/);
 assert.match(card,/Approve coding for draft PR/);
 assert.match(card,/\/api\/missions\/pending/);
 assert.match(card,/action:'approve',id:approval.missionId,jobId:approval.jobId/);
 assert.match(card,/does not authorize merging or deployment/);
});

test('pending approvals expose only actionable development assignments',async()=>{
 const get=route(
  [{id:'mission-1',objective:'Write test',created_at:'2026-10-19T00:00:00Z'}],
  [{id:'job-1',mission_id:'mission-1',role:'development',status:'awaiting_approval',
    instruction:'Write tests',payload:{development_input:'Saved exact input'}}]
 );
 const response=await get();
 assert.equal(response.status,200);
 assert.equal(response.body.approvals.length,1);
 assert.equal(response.body.approvals[0].jobId,'job-1');
 assert.equal(response.body.approvals[0].codingInput,'Saved exact input');
 assert.equal(response.headers['Cache-Control'],'no-store');
});

test('when no mission awaits approval the home page has no approval cards',async()=>{
 const response=await route([],[])();
 assert.equal(response.status,200);
 assert.equal(response.body.approvals.length,0);
});

test('approval discovery does not report false clearance on database failure',async()=>{
 const response=await route([],[],'agent_missions')();
 assert.equal(response.status,503);
 assert.match(response.body.error,/unavailable/);
});
