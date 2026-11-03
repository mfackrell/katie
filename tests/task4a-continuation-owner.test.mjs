import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {modules} from './helpers/load-project-modules.mjs';

test('Task 4A continuation is owner-authenticated, scope-bound and exactly one explicit consent',async()=>{
 const actor=randomUUID(),chat=randomUUID(),digest='a'.repeat(64),projectId='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
 let owner=false,status='paused',readCalls=0,authCalls=0;
 const db={
  from(table){assert.equal(table,'work_projects');return{
   select(){return this;},eq(key,value){assert.equal(key,'id');assert.equal(value,projectId);return this;},
   maybeSingle:async()=>{readCalls++;return {data:{id:projectId,status,phase:'research',actor_id:actor,chat_id:chat,active_mission_id:randomUUID()},error:null};}
  };},
  rpc:async(name,args)=>{
   if(name==='task4a_continuation_proposal')return {data:{ready:true,digest,proposal:{incrementalTokens:440326,incrementalCalls:53}},error:null};
   assert.equal(name,'authorize_task4a_expired_research');
   assert.equal(args.p_id,projectId);
   assert.equal(args.p_actor,actor);
   assert.equal(args.p_chat,chat);
   assert.equal(args.p_digest,digest);
   authCalls++;
   return {data:{authorized:true,oldMissionId:'original',newMissionId:'continuation',authorizationId:'approval',originalTokens:76519,originalCalls:9,additionalTokens:440326,additionalCalls:53,additionalMicrousd:15000000},error:null};
  }
 };
 const {GET,POST}=modules({
  'next/server':{NextResponse:{json:(value,options)=>Response.json(value,options)}},
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db}
 })('@/app/api/projects/task4a-continuation/route');
 const request=(body)=>new Request('https://katie.local/api/projects/task4a-continuation',{
  method:'POST',headers:{'Content-Type':'application/json',Origin:'https://katie.local'},
  body:JSON.stringify(body)
 });
 assert.equal((await GET(new Request('https://katie.local/api/projects/task4a-continuation'))).status,401);
 assert.equal((await POST(request({approve:true,proposalDigest:digest}))).status,403);
 assert.equal(readCalls,0);assert.equal(authCalls,0);
 owner=true;
 const preflight=await GET(new Request('https://katie.local/api/projects/task4a-continuation'));
 assert.equal(preflight.status,200);
 const view=await preflight.json();assert.equal(view.continuation.digest,digest);assert.equal(view.chatId,chat);
 assert.equal((await POST(request({approve:false,proposalDigest:digest}))).status,400);
 assert.equal((await POST(request({approve:true,proposalDigest:'f'.repeat(64)}))).status,409);
 assert.equal(authCalls,0);
 const authorized=await POST(request({approve:true,proposalDigest:digest}));
 assert.equal(authorized.status,200);
 const response=await authorized.json();
 assert.equal(response.accepted,true);
 assert.equal(response.authorizedIncrementalTokens,440326);
 assert.equal(response.scopeApprovalStillRequired,true);
 assert.equal(authCalls,1);
 status='running';
 assert.equal((await POST(request({approve:true,proposalDigest:digest}))).status,409,'Replay cannot reopen original pause');
 assert.equal(authCalls,1);
});
