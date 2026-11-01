import test from 'node:test';
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server.js';
import {modules} from './helpers/load-project-modules.mjs';
import config from '../config/benchmark-715-production-qualification.json' with {type:'json'};

test('actual owner API binds authenticated identity, immutable proposal, origin and fresh checkpoint before commit',async t=>{
 const owner='11111111-1111-4111-8111-111111111111',task='22222222-2222-4222-8222-222222222222',id='a'.repeat(64),checkpoint={checkpointSha:'b'.repeat(40)};
 const oldEnv={...process.env},oldFetch=globalThis.fetch;let user={id:owner,is_anonymous:false},valid=true,stale=false,committed=null,calls=0,evidenceReads=0;
 Object.assign(process.env,{VERCEL_ENV:'production',NEXT_PUBLIC_SUPABASE_URL:config.productionDatabaseUrl,NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-public-key',KATIE_OWNER_AUTH_USER_ID:owner});
 globalThis.fetch=async(url,options)=>{assert.equal(url,config.productionDatabaseUrl+'/auth/v1/user');assert.equal(options.headers.Authorization,'Bearer synthetic-session');return Response.json(valid?user:{error:'invalid token'},{status:valid?200:401});};
 t.after(()=>{globalThis.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key];Object.assign(process.env,oldEnv);});
 const offer={id,owner_id:owner,task_id:task,snapshot_hash:'c'.repeat(64),checkpoint,expires_at:new Date(Date.now()+3600000).toISOString()};
 const db={from(table){const filters={};const chain={select:()=>chain,eq:(key,value)=>{filters[key]=value;return chain},maybeSingle:async()=>({error:null,data:table==='benchmark_lifecycle_decisions'?committed:table==='benchmark_lifecycle_proposals'&&filters.id===id&&filters.owner_id===owner&&filters.task_id===task?offer:null})};return chain;},async rpc(name,args){assert.equal(name,'benchmark_lifecycle_decide');assert.deepEqual(JSON.parse(JSON.stringify(args)),{p_owner:owner,p_task:task,p_proposal:id,p_decision:'approved',p_release:'d'.repeat(40)});calls++;committed={decision:'approved',continuation_id:'synthetic-continuation'};return {data:{state:'approved',proposalId:id,continuationId:committed.continuation_id},error:null};}};
 const route=modules({'@/config/benchmark-715-production-qualification.json':config,'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/agents/development':{qualifiedDevelopmentAmendmentRelease:async()=> 'd'.repeat(40),authenticatedLifecycleCheckpoint:async()=>{evidenceReads++;return {snapshot:{ownerId:owner,snapshotHash:stale?'e'.repeat(64):offer.snapshot_hash},checkpoint};}}})('@/app/api/projects/lifecycle-approval/route');
 const request=(body={taskId:task,proposalId:id,decision:'approved'},origin=config.productionUrl)=>new NextRequest(config.productionUrl+'/api/projects/lifecycle-approval',{method:'POST',headers:{Authorization:'Bearer synthetic-session','Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
 valid=false;assert.equal((await route.POST(request())).status,403);valid=true;
 user={...user,id:'33333333-3333-4333-8333-333333333333'};assert.equal((await route.POST(request())).status,403);user.id=owner;
 user.is_anonymous=true;assert.equal((await route.POST(request())).status,403);user.is_anonymous=false;
 assert.equal((await route.POST(request(undefined,'https://untrusted.invalid'))).status,403);
 assert.equal((await route.POST(request({taskId:task,proposalId:id,decision:'approved',additionalTokens:1000000}))).status,400);
 assert.equal((await route.POST(request({taskId:owner,proposalId:id,decision:'approved'}))).status,403);
 assert.equal((await route.POST(request({taskId:task,proposalId:'f'.repeat(64),decision:'approved'}))).status,403);
 stale=true;assert.equal((await route.POST(request())).status,409);stale=false;assert.equal(calls,0);
 offer.expires_at='2020-01-01';assert.equal((await route.POST(request())).status,409);offer.expires_at=new Date(Date.now()+3600000).toISOString();
 assert.equal((await route.POST(request())).status,200);assert.equal(calls,1);assert.equal(evidenceReads,2);
 assert.equal((await route.POST(request())).status,200);assert.equal(calls,1,'idempotent response cannot commit duplicate authority');
 assert.equal((await route.POST(request({taskId:task,proposalId:id,decision:'rejected'}))).status,409);
});

test('owner polling automatically refreshes a changed blocked task and preserves unchanged rejected proposals',async t=>{
 const owner='11111111-1111-4111-8111-111111111111',task='22222222-2222-4222-8222-222222222222';
 const oldEnv={...process.env},oldFetch=globalThis.fetch;Object.assign(process.env,{VERCEL_ENV:'production',NEXT_PUBLIC_SUPABASE_URL:config.productionDatabaseUrl,NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-public-key',KATIE_OWNER_AUTH_USER_ID:owner});
 globalThis.fetch=async()=>Response.json({id:owner,is_anonymous:false});t.after(()=>{globalThis.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key];Object.assign(process.env,oldEnv);});
 let saved={id:'a'.repeat(64),owner_id:owner,task_id:task,snapshot_hash:'old',expires_at:new Date(Date.now()+3600000).toISOString(),proposal:{id:'a'.repeat(64)}},decision={decision:'approved',continuation_id:'old-continuation'},preparations=0;
 const db={from(table){const filters={};const answer=()=>({error:null,data:table==='benchmark_native_spending_approvals'?[{id:'authority'}]:table==='benchmark_lifecycle_proposals'?[saved]:table==='agent_tasks'?{status:'blocked'}:table==='benchmark_lifecycle_decisions'?(filters.proposal_id===saved.id?decision:null):null});const chain={select:()=>chain,eq:(k,v)=>{filters[k]=v;return chain},order:()=>chain,limit:()=>chain,returns:async()=>answer(),maybeSingle:async()=>answer()};return chain;},rpc:async()=>({error:null,data:{snapshotHash:'new'}})};
 const route=modules({'@/config/benchmark-715-production-qualification.json':config,'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/agents/development':{prepareLifecycleOwnerProposal:async()=>{preparations++;saved={...saved,id:'b'.repeat(64),snapshot_hash:'new',proposal:{id:'b'.repeat(64)}};decision=null;return {offer:saved};}}})('@/app/api/projects/lifecycle-approval/route');
 const request=()=>new NextRequest(config.productionUrl+'/api/projects/lifecycle-approval?taskId='+task,{headers:{Authorization:'Bearer synthetic-session'}});
 let result=await route.GET(request());assert.equal(result.status,200);assert.equal((await result.json()).state,'pending');assert.equal(preparations,1);
 result=await route.GET(request());assert.equal((await result.json()).state,'pending');assert.equal(preparations,1);
 decision={decision:'rejected',continuation_id:null};result=await route.GET(request());assert.equal((await result.json()).state,'rejected');assert.equal(preparations,1);
});
