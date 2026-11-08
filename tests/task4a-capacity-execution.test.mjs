import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';
test('capacity successor execution requires its own fresh consent and never retries ambiguous dispatch',async()=>{
 const owner='04ed6c05-a586-4a56-ba81-1b50e378746b',sha='e'.repeat(40),digest='f'.repeat(64);
 const prior={KATIE_OWNER_AUTH_USER_ID:process.env.KATIE_OWNER_AUTH_USER_ID,VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA};
 Object.assign(process.env,{KATIE_OWNER_AUTH_USER_ID:owner,VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha});
 let signed=false,authorized=false,claimed=false,dispatches=0,proofs=0,live=true;
 const db={from:()=>({select:()=>({eq:()=>({in:()=>({returns:async()=>({data:authorized?[{id:'new-owner-receipt',event:'task4a_capacity_execution_authorized',data:{}},
  ...(claimed?[{id:'new-claim',event:'task4a_capacity_execution_claimed',data:{}}]:[])]:[],error:null})})})})}),
 rpc:async(name,args)=>{
  assert.equal(args.p_release,sha);assert.equal(args.p_evidence,undefined);
  if(name==='task4a_capacity_execution_proposal')return {data:{ready:live,digest,proposal:{ownerId:owner,deadline:'existing-deadline',checkpoint:{verified:true}}},error:null};
  assert.equal(name,'task4a_capacity_execution_authorize');assert.equal(args.p_owner,owner);assert.equal(args.p_digest,digest);
  assert.equal(authorized,false);authorized=true;
  return {data:{authorized:true,receiptId:'new-owner-receipt',dispatched:false,newPaidCalls:0,newFinancialAuthority:false},error:null};
 }};
 const {GET,POST}=modules({
  'next/server':{NextResponse:{json:(b,o)=>Response.json(b,o)}},
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>signed},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},
  '@/lib/agents/development':{authenticatedTask4aCapacityCheckpoint:async()=>{proofs++;return {checkpoint:{verified:true}};},
   qualifiedOrdinaryDevelopmentRelease:async()=>sha,
   dispatchTask4aCapacityOnce:async()=>{dispatches++;claimed=true;throw Error("Simulated lost GitHub acceptance response");}}
 })('@/app/api/projects/task4a-capacity-execution/route');
 const url='https://katie.local/api/projects/task4a-capacity-execution';
 const get=()=>GET(new Request(url+'?chatId=e53defeb-16eb-457e-aa07-435141165ee8'));
 const post=body=>POST(new Request(url,{method:'POST',body:JSON.stringify(body)}));
 const decision={action:'approveSuccessorExecution',confirm:true,digest};
 try{
  assert.equal((await get()).status,401);assert.equal((await post(decision)).status,403);
  signed=true;
  assert.equal((await(await get()).json()).state,'pending_replacement');assert.equal(dispatches,0);assert.equal(authorized,false);
  assert.equal((await post({...decision,limits:{ceilingMicrousd:10000000}})).status,400);
  assert.equal((await post({...decision,digest:'0'.repeat(64)})).status,409);
  live=false;assert.equal((await post(decision)).status,409);assert.equal(authorized,false);live=true;
  const accepted=await(await post(decision)).json();assert.equal(accepted.accepted,true);assert.equal(accepted.dispatchAccepted,false);
  assert.equal(accepted.newFinancialAuthority,false);assert.equal(dispatches,1);assert.ok(proofs>=4);
  assert.equal((await post(decision)).status,409);assert.equal(dispatches,1);
  assert.equal((await(await get()).json()).state,'claimed_once');
 }finally{for(const [k,v] of Object.entries(prior))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('actual successor dispatcher claims before GitHub and never retries uncertain acceptance',async()=>{
 const {readFileSync}=await import('node:fs'),vm=await import('node:vm'),ts=await import('typescript');
 const src=readFileSync('lib/agents/development.ts','utf8'),fn=src.indexOf('async function dispatchOrdinaryNativeDevelopment');
 const start=src.indexOf('  const issue=Number(task.external.issueNumber);',fn),end=src.indexOf('\n if(rows.data.length<8)',start);
 assert.ok(start>0&&end>start);
 const segment=src.slice(start,end); // Includes loop-closing brace.
 const code=ts.default.transpileModule('(async()=>{for(const a of [approval]){'+segment+'return false;})()',
  {compilerOptions:{target:ts.default.ScriptTarget.ES2022,module:ts.default.ModuleKind.None}}).outputText;
 const task={id:'d0e41ff5-149e-4319-9e65-dcc605fb75da',external:{issueNumber:969}},release='e'.repeat(40);
 const c={projectId:'6d1c29f1-b31e-47a5-aabb-cbcf1326f388',scopeHash:'scope',contractHash:'contract',baselineSha:'baseline'};
 const proof={authorityKind:'task4a-developer',taskId:task.id,projectId:c.projectId,approvalId:'old-approval',accountId:'account',scopeHash:c.scopeHash,contractHash:c.contractHash,baselineSha:c.baselineSha,releaseSha:'3c148a4ea9a2f8bee9d35b7e430eee0f66ff58a0'};
 let authorized=false,claimed=false,uncertain=false;const events=[];
 const context={task,release,c,key:'test-key',postpaid:true,finalExecution:false,capacityRenewal:true,replacement:false,body:'new signed body',
  approval:{id:'new-approval',previous_developer_approval_id:'old-approval',account_id:'account'},
  binding:{owner:'mfackrell',repo:'katie'},marker:()=> 'task-marker',unpackDevelopmentRequest:x=>x,readDeveloperHandoff:()=>proof,
  readTask:async()=>task,
  db:{rpc:async name=>{events.push(name);if(name==='task4a_capacity_execution_authorized')return{data:authorized,error:null};
   if(name==='task4a_capacity_execution_claim'){const accept=!claimed;claimed=true;return {data:accept,error:null};}
   assert.equal(name,'task4a_capacity_execution_submitted');return{data:true,error:null};}},
  client:{issues:{get:async()=>({data:{user:{login:'mfackrell'},body:'task-marker\nprior signed request'}}),update:async()=>events.push('issue-update')},
   actions:{createWorkflowDispatch:async()=>{events.push('dispatch');if(uncertain)throw Error('uncertain GitHub acceptance');}}}};
 assert.equal(await vm.runInNewContext(code,context),false);assert.deepEqual(events,['task4a_capacity_execution_authorized']);
 events.length=0;authorized=true;uncertain=true;
 await assert.rejects(vm.runInNewContext(code,context),/uncertain/);
 assert.deepEqual(events,['task4a_capacity_execution_authorized','task4a_capacity_execution_claim','issue-update','dispatch']);
 events.length=0;assert.equal(await vm.runInNewContext(code,context),false);
 assert.deepEqual(events,['task4a_capacity_execution_authorized','task4a_capacity_execution_claim']);
});

test('actual native recovery selects latest paid checkpoint only after separate execution claim',async()=>{
 const {readFileSync}=await import('node:fs'),vm=await import('node:vm');
 const src=readFileSync('scripts/benchmark/native-development-host.mjs','utf8'),start=src.indexOf(' let linkedEvidence=null;'),end=src.indexOf(' // Authenticated diagnostics',start);
 assert.ok(start>0&&end>start);
 let ready=false,restores=0;
 const context={task:{external:{task4aCapacityConsentDigest:'consent',task4aReplacementClaimId:'old-consumed'}},approval:{id:'successor'},
  process:{env:{GITHUB_SHA:'e'.repeat(40),GITHUB_REPOSITORY:'mfackrell/katie'}},priorRefs:[{}],wipContext:{},
  denied:message=>{throw Error(message);},db:{rpc:async(name,args)=>{assert.equal(name,'task4a_capacity_execution_ready');assert.equal(args.p_approval,'successor');return {data:ready,error:null};}},
  githubRecoveryReader:()=> 'authenticated-reader',loadTask4aLinkedDiagnostics:()=>assert.fail('Old failed-host bridge must not be selected'),
  loadRecoveryDiagnostics:async({github})=>{assert.equal(github,'authenticated-reader');restores++;return {record:{checkpointSha:'2667a81d4f18452e9ca59498c8805670b04cfe47'},diagnostics:{}};}};
 const code='(async()=>{'+src.slice(start,end)+';return record;})()';
 await assert.rejects(vm.runInNewContext(code,context),/Fresh capacity-successor execution claim required/);assert.equal(restores,0);
 ready=true;assert.equal((await vm.runInNewContext(code,context)).checkpointSha,'2667a81d4f18452e9ca59498c8805670b04cfe47');assert.equal(restores,1);
});
