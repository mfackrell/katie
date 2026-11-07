import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {modules} from './helpers/load-project-modules.mjs';

const project='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const task='d0e41ff5-149e-4319-9e65-dcc605fb75da';
const mission='d3fd3d95-7287-4bfc-8c97-c105fde46c36';
const release='2147b910ad7bba849e8f4de7cf91f36a3410595e';
const originalChat='e53defeb-16eb-457e-aa07-435141165ee8';
const scope='a'.repeat(64);

test('ordinary dispatch rejects a blocked project, while the original paid preclaim may inspect it read-only',async()=>{
 const binding={version:1,projectId:project,scopeHash:scope,baseSha:'b'.repeat(40),
  baselineSha:'b'.repeat(40),allowedPaths:['app/project-pilots/task4a-preview-probe/'],
  contractHash:'c'.repeat(64),contract:{path:'/project-pilots/task4a-preview-probe/',scenarios:[]}};
 const projectRow={id:project,status:'blocked',phase:'development',profile:'software',
  approved_hash:scope,approval_hash:scope,active_mission_id:mission};
 const values={
  mission_assignments:{mission_id:mission},
  project_runs:{mission_id:mission,project_id:project,binding,kind:'development'},
  work_projects:projectRow
 };
 const db={from(table){
  assert.ok(table in values,'Only the original project binding may be queried');
  const chain={
   select:()=>chain,
   eq:(key,value)=>{assert.ok(typeof value==='string');return chain;},
   maybeSingle:async()=>({data:values[table],error:null})
  };
  return chain;
 }};
 const store=modules({
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},
  '@/lib/missions/store':{rpc:async()=>{},readMission:async()=>{}}
 })('@/lib/projects/store');
 assert.equal((await store.getDevelopmentProjectContext(task,false)).projectId,project);
 await assert.rejects(store.getDevelopmentProjectContext(task,true),/Approved project scope is unavailable or changed/);
 projectRow.status='running';
 assert.equal((await store.getDevelopmentProjectContext(task,true)).projectId,project);
 // A blanket bypass would let unrelated blocked work dispatch. The scoped
 // preclaim allowance is original task + original project + paid successor only.
 const native=readFileSync('lib/agents/development.ts','utf8');
 const start=native.indexOf('const task4aPostpaidPreclaim=');
 const end=native.indexOf('const client=github()',start);
 assert.ok(start>0&&end>start);
 const fenced=native.slice(start,end);
 assert.match(fenced,/a\\.project_id==='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'/);
 assert.match(fenced,/a\\.task_id==='d0e41ff5-149e-4319-9e65-dcc605fb75da'/);
 assert.match(fenced,/Boolean\\(a\\.previous_developer_approval_id\\)/);
 assert.match(fenced,/task4aPostpaid\\?\\.version==='postpaid-same-task-v1'/);
 assert.match(fenced,/getDevelopmentProjectContext\\(task.id,!task4aPostpaidPreclaim\\)/);
 assert.match(fenced,/task.status!=='blocked'/);
 assert.match(fenced,/p.status!=='blocked'/);
 assert.match(fenced,/j.status!=='failed'/);
 assert.match(fenced,/m.status!=='blocked'/);
 assert.match(fenced,/p.approved_hash!==p.approval_hash/);
 assert.match(native,/task4a_postpaid_paid_proposal/);
 assert.match(native,/task4a_postpaid_claim/);
 console.log('TASK4A_BLOCKED_PRECLAIM_LOADER_SCOPE_IS_EXACT_AND_ONE_SHOT_SQL_REMAINS');
});

test('paid authorization already recorded: no second approval button or implicit dispatch',async()=>{
 const old={owner:process.env.KATIE_OWNER_AUTH_USER_ID,environment:process.env.VERCEL_ENV,sha:process.env.VERCEL_GIT_COMMIT_SHA};
 process.env.KATIE_OWNER_AUTH_USER_ID='04ed6c05-a586-4a56-ba81-1b50e378746b';
 process.env.VERCEL_ENV='production';process.env.VERCEL_GIT_COMMIT_SHA=release;
 let dispatches=0,rpcs=0;
 const records=[
  {id:'authority-1',event:'task4a_postpaid_owner_authorized',data:{}},
  {id:'redispatch-1',event:'task4a_postpaid_redispatch_authorized',data:{}},
  {id:'paid-1',event:'task4a_postpaid_paid_authorized',data:{}}
 ];
 const db={
  from:(table)=>{
   assert.equal(table,'project_events');
   return {select:()=>({eq:()=>({in:()=>({returns:async()=>({data:records,error:null})})})})};
  },
  rpc:async()=>{rpcs++;throw Error('Duplicate approvals must not call a new database RPC');}
 };
 const {GET,POST}=modules({
  'next/server':{NextResponse:{json:(body,options)=>Response.json(body,options)}},
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>true},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},
  '@/lib/agents/development':{
   dispatchTask4aPostpaidOnce:async()=>{dispatches++;return true;},
   authenticatedLifecycleCheckpoint:async()=>{throw Error('No new checkpoint reads are required');},
   qualifiedOrdinaryDevelopmentRelease:async()=>release
  },
  '@/lib/projects/contract':{digest:()=> 'f'.repeat(64)}
 })('@/app/api/projects/task4a-postpaid-continuation/route');
 const url='https://katie.local/api/projects/task4a-postpaid-continuation';
 try{
  const status=await(await GET(new Request(url+'?chatId='+originalChat))).json();
  assert.equal(status.state,'paid_authorized_pending_dispatch');
  assert.equal(status.paidReceiptId,'paid-1');
  assert.equal(status.authorityReceiptId,'authority-1');
  assert.equal(status.redispatchReceiptId,'redispatch-1');
  assert.equal(status.noAutomaticRetry,true);
  assert.equal(status.dispatched,false);
  assert.equal(status.nextAction,undefined,'Already recorded paid receipt cannot show a second consent control');
  assert.equal(rpcs,0);assert.equal(dispatches,0);
  const denied=await POST(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({action:'approvePaidInference',confirm:true,digest:'c'.repeat(64)})}));
  assert.equal(denied.status,409);
  assert.equal(rpcs,0);assert.equal(dispatches,0);
 }finally{
  for(const [key,value] of Object.entries({
   KATIE_OWNER_AUTH_USER_ID:old.owner,VERCEL_ENV:old.environment,VERCEL_GIT_COMMIT_SHA:old.sha
  }))if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
 console.log('TASK4A_PAID_RECEIPT_NO_REPLAY_HTTP_ROUTE_PASS');
});

test('new production release must not silently inherit the old release-bound paid consent',()=>{
 const sql=readFileSync('supabase/migrations/20261105224500_task4a_postpaid_same_task_continuation.sql','utf8');
 assert.match(sql,/redispatch.data->'proposal'->>'releaseSha' is distinct from p_release/);
 assert.match(sql,/paid.data->'proposal' is distinct from offer->'proposal'/);
 assert.match(sql,/paid.data->>'consentDigest' is distinct from offer->>'digest'/);
 assert.match(sql,/task4a_postpaid_dispatch_claimed/);
});
