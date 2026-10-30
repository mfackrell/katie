import test, {beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {executeStandaloneWorkflow,cachedWorkflowValue,workflowMessageId,workflowTimestamp} from '../lib/standalone-accounting/workflow';
import {getAccountingScope} from '../lib/standalone-accounting/context';
import {canonicalJson} from '../lib/standalone-accounting/estimate';
const owner='11111111-1111-4111-8111-111111111111',actorId='22222222-2222-4222-8222-222222222222',chatId='33333333-3333-4333-8333-333333333333';
let stored:any,allowed=true,executions=0,checkpoints=0,pending=false;
const payload={message:'Original task',chatId,actorId};
function request(resume=false){return new NextRequest('http://localhost/api/chat',{method:'POST',headers:{authorization:'Bearer server-verified-token','content-type':'application/json','x-request-id':'original-request'},body:JSON.stringify(resume?{actorId,chatId,standaloneResume:true}:payload)});}
beforeEach(()=>{
 stored=undefined;allowed=true;executions=0;checkpoints=0;pending=false;
 process.env.NEXT_PUBLIC_SUPABASE_URL='https://auth.example.test';process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='public';
 globalThis.fetch=async()=>Response.json({id:owner});
 globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__={rpc:async(name:string,args:any)=>{
  let data:any;
  if(name==='standalone_authorize_scope')data=allowed&&args.p_owner===owner&&args.p_actor===actorId&&args.p_chat===chatId;
  else if(name==='standalone_load_workflow')data=stored;
  else if(name==='standalone_claim_workflow'){
   if(stored&&stored.request_hash!==args.p_hash)return {data:null,error:{message:'STANDALONE_WORKFLOW_CONFLICT'}};
   if(!stored)stored={owner_id:owner,actor_id:actorId,chat_id:chatId,request_id:args.p_request,request_body:JSON.parse(canonicalJson(args.p_body)),request_hash:args.p_hash,status:'pending',created_at:'2026-10-28T00:00:00Z',checkpoints:{}};
   if(stored.status==='completed'||stored.status==='running')data={...stored,claimed:false};
   else {stored.status='running';stored.lease_token='fenced-token';data={...stored,claimed:true};}
  }else if(name==='standalone_checkpoint_workflow'){
   assert.equal(args.p_lease,stored.lease_token);checkpoints++;stored.checkpoints[args.p_key]=args.p_value;data=args.p_value;
  }else if(name==='standalone_finish_workflow'){
   assert.equal(args.p_lease,stored.lease_token);stored.status=args.p_status!=='paused'&&pending?'paused':args.p_status;stored.result=args.p_result;data=stored;
  }else throw Error(`Unexpected RPC ${name}`);
  return {data:JSON.parse(JSON.stringify(data)),error:null};
 }} as unknown as NonNullable<typeof globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__>;
});
test('workflow binds authenticated owner before executing preparation and rejects cross-owner scope',async()=>{
 allowed=false;await assert.rejects(executeStandaloneWorkflow(request(),payload,async()=>{executions++;return Response.json({});}),/authorization denied/i);assert.equal(executions,0);
});
test('durable pause and fresh resume replay immutable inputs and execution context',async()=>{
 let firstId:string|undefined;let loads=0;
 const execute=async(req:NextRequest)=>{
  executions++;assert.deepEqual(await req.json(),payload);
  const scope=getAccountingScope();assert.equal(scope?.kind,'standalone');if(scope?.kind==='standalone'){assert.equal(scope.context.userId,owner);assert.equal(scope.context.requestId,'original-request');}
  const value=await cachedWorkflowValue('initial-context',async()=>{loads++;return {history:['before paid work']};});assert.deepEqual(value,{history:['before paid work']});
  assert.equal(workflowTimestamp(),'2026-10-28T00:00:00Z');
  if(!firstId)firstId=workflowMessageId('user');else assert.equal(workflowMessageId('user'),firstId);
  return new Response(executions===1?'{"type":"accounting_pause","code":"standalone_approval_required"}\n':'{"type":"content","text":"completed"}\n',{headers:{'content-type':'application/x-ndjson'}});
 };
 await executeStandaloneWorkflow(request(),payload,execute);assert.equal(stored.status,'paused');assert.equal(executions,1);
 const resumed=await executeStandaloneWorkflow(request(true),{actorId,chatId,standaloneResume:true},execute);assert.match(await resumed.text(),/completed/);assert.equal(stored.status,'completed');assert.equal(loads,1);assert.equal(checkpoints,1);
 const replay=await executeStandaloneWorkflow(request(true),{actorId,chatId,standaloneResume:true},execute);assert.match(await replay.text(),/completed/);assert.equal(executions,2,'completed request does not reexecute');
});
test('simultaneous reconnect returns existing fenced workflow without running twice',async()=>{
 let unblock!:()=>void;const gate=new Promise<void>(resolve=>{unblock=resolve});
 const execute=async()=>{executions++;await gate;return new Response('done');};
 const first=executeStandaloneWorkflow(request(),payload,execute);
 while(executions===0)await new Promise(resolve=>setTimeout(resolve,1));
 const duplicate=await executeStandaloneWorkflow(request(),payload,execute);assert.equal(duplicate.status,202);assert.equal(executions,1);unblock();await first;
});
test('changed original body is rejected and never becomes resumed spending authority',async()=>{
 await executeStandaloneWorkflow(request(),payload,async()=>new Response('completed'));
 await assert.rejects(executeStandaloneWorkflow(request(),{...payload,message:'Changed payload'},async()=>{executions++;return new Response('bad');}),/WORKFLOW_CONFLICT/);assert.equal(executions,0);
});

test('a hidden pending attempt remains visible even when its optional caller returned success',async()=>{
 pending=true;
 const response=await executeStandaloneWorkflow(request(),payload,async()=>new Response('{"type":"content","text":"answer already saved"}\n',{headers:{'content-type':'application/x-ndjson'}}));
 assert.equal(stored.status,'paused');assert.match(await response.text(),/standalone_pending_attempt/);
});

test('a transient HTTP failure cannot strand already reserved supporting work',async()=>{
 pending=true;
 const response=await executeStandaloneWorkflow(request(),payload,async()=>Response.json({error:'Transient preparation unavailable'},{status:503}));
 assert.equal(response.status,402);assert.equal(stored.status,'paused');assert.equal((await response.json()).code,'standalone_pending_attempt');
});
test('a generic preparation exception surfaces the database durable pause instead of terminal failure',async()=>{
 pending=true;
 await assert.rejects(executeStandaloneWorkflow(request(),payload,async()=>{throw Error('Temporary discovery failure')}),error=>Boolean(error&&typeof error==='object'&&'code' in error&&error.code==='standalone_pending_attempt'));
 assert.equal(stored.status,'paused');
});
test('SDK-wrapped accounting denial preserves its pause across execution boundaries',async()=>{
 const denial=Object.assign(Error('Connection error'),{cause:Object.assign(Error('Approval required'),{code:'standalone_approval_required'})});
 await assert.rejects(executeStandaloneWorkflow(request(),payload,async()=>{throw denial}),error=>error===denial.cause);
 assert.equal(stored.status,'paused');
});

test('stream execution failure is never persisted as successful completion',async()=>{
 const response=await executeStandaloneWorkflow(request(),payload,async()=>new Response('{"type":"reasoning_error","message":"Saved preparation failed"}\n',{headers:{'content-type':'application/x-ndjson'}}));
 assert.equal(stored.status,'failed');assert.match(await response.text(),/Saved preparation failed/);
});

test('deterministic image limitations are saved as terminal failures rather than approval loops',async()=>{
 const response=await executeStandaloneWorkflow(request(),payload,async()=>new Response('{"type":"accounting_pause","code":"standalone_no_priceable_vision","message":"No supported image escalation"}\n',{headers:{'content-type':'application/x-ndjson'}}));
 assert.equal(stored.status,'failed');assert.match(await response.text(),/standalone_no_priceable_vision/);
});

test('a non-approvable model context blocker is terminal and does not strand a workflow paused',async()=>{
  const response=await executeStandaloneWorkflow(request(),payload,async()=>new Response(
    JSON.stringify({type:'reasoning_error',code:'standalone_context_capacity_unverified',message:'No newer context-capable model is available.'})+'\\n',
    {headers:{'content-type':'application/x-ndjson'}}));
  assert.equal(stored.status,'failed');
  assert.match(await response.text(),/standalone_context_capacity_unverified/);
  assert.equal(executions,0,'no paid provider generation is required for technical failure');
});

test('assistant text mentioning an image limitation code is not execution authority',async()=>{
 const response=await executeStandaloneWorkflow(request(),payload,async()=>new Response(JSON.stringify({type:'content',text:'The error standalone_no_priceable_vision means there is no supported escalation.'})+'\n',{headers:{'content-type':'application/x-ndjson'}}));
 assert.equal(stored.status,'completed');assert.match(await response.text(),/standalone_no_priceable_vision/);
});

test('authenticated cron can resume only a paused accepted Qwen job, never create or change spending authority',async()=>{
 const savedSecret=process.env.CRON_SECRET;
 process.env.CRON_SECRET='test-cron-secret-with-at-least-thirty-two-bytes';
 try{
  const execute=async()=>{executions++;return new Response(executions===1
   ? '{"type":"accounting_pause","code":"standalone_runpod_in_progress"}\n'
   : '{"type":"content","text":"image observed"}\n',
   {headers:{'content-type':'application/x-ndjson'}});};
  await executeStandaloneWorkflow(request(),payload,execute);
  assert.equal(stored.status,'paused');stored.error='StandaloneAccountingError: standalone_runpod_in_progress: Qwen still processing';
  let hasJob=true;
  const admin=globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__ as unknown as Record<string,unknown>;
  admin.from=(table:string)=>{
   const chain:Record<string,unknown>={};
   for(const name of ['select','eq','not','is'])chain[name]=()=>chain;
   chain.maybeSingle=async()=>({data:table==='standalone_workflows'?{
     owner_id:owner,actor_id:actorId,chat_id:chatId,status:stored.status,error:stored.error
   }:null,error:null});
   chain.limit=async()=>({data:table==='standalone_provider_attempts'&&hasJob?[{id:'qwen-job',provider_request_id:'job-accepted-123'}]:[],error:null});
   return chain;
  };
  const cronRequest=()=>new NextRequest('http://localhost/api/chat',{method:'POST',headers:{
   authorization:'Bearer '+process.env.CRON_SECRET,'content-type':'application/json','x-request-id':'original-request'
  },body:JSON.stringify({actorId,chatId,standaloneResume:true})});
  hasJob=false;
  await assert.rejects(executeStandaloneWorkflow(cronRequest(),{actorId,chatId,standaloneResume:true},execute),
    {code:'standalone_resume_denied'});
  assert.equal(executions,1,'no Qwen job means no cron execution');
  hasJob=true;
  const response=await executeStandaloneWorkflow(cronRequest(),{actorId,chatId,standaloneResume:true},execute);
  assert.match(await response.text(),/image observed/);
  assert.equal(stored.status,'completed');assert.equal(executions,2);
  await assert.rejects(executeStandaloneWorkflow(cronRequest(),{actorId,chatId,standaloneResume:true},execute),
    {code:'standalone_resume_denied'});
  assert.equal(executions,2,'completed work cannot be dispatched again by cron');
 }finally{
  if(savedSecret===undefined)delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET=savedSecret;
 }
});
