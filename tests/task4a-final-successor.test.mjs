import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {modules} from './helpers/load-project-modules.mjs';
import {TASK4A_SUCCESSOR_ENVELOPE as envelope} from '../scripts/benchmark/task4a-successor-envelope.mjs';
import {createNativeHttpBridge} from '../scripts/benchmark/native-http-bridge.mjs';
test('owner route separates capacity, replacement, paid inference and dispatch; missing proof and replay deny',async()=>{
 const old={...process.env};Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:'e'.repeat(40),KATIE_OWNER_AUTH_USER_ID:'owner'});
 let signed=false,wip=true,qualified=true,dispatches=0;const rows=[],writes=[];
 const events={finance:'task4a_final_owner_authorized',replacement:'task4a_final_execution_authorized',inference:'task4a_final_inference_authorized',dispatch:'task4a_final_dispatch_authorized'};
 const db={from:()=>({select:()=>({eq:()=>({in:()=>({returns:async()=>({data:rows,error:null})})})})}),rpc:async(name,args)=>{
 const action=name==='task4a_final_proposal'||name==='task4a_final_authorize'?'finance':args.p_action;
 if(name.endsWith('proposal'))return {data:{ready:true,digest:action==='finance'?'a'.repeat(64):action==='replacement'?'b'.repeat(64):action==='inference'?'c'.repeat(64):'d'.repeat(64),proposal:{ownerId:'owner',checkpoint:{authenticated:true}}},error:null};
 writes.push(action);rows.push({id:action,event:events[action],data:{ownerId:'owner',result:{approvalId:'child'}}});return {data:{authorized:true,newPaidCalls:0},error:null};
 }};
 const load=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>signed},'@/lib/agents/development':{
 authenticatedTask4aFinalCheckpoint:async()=>{if(!wip)throw Error('missing WIP');return {checkpoint:{authenticated:true}};},qualifiedOrdinaryDevelopmentRelease:async()=>qualified?'e'.repeat(40):'f'.repeat(40),dispatchTask4aFinalOnce:async()=>{dispatches++;rows.push({id:'claim',event:'task4a_final_execution_claimed',data:{}});throw Error('uncertain acceptance');}}});
 const route=load('@/app/api/projects/task4a-final-successor/route');
 const post=(action,digest)=>route.POST(new Request('https://katie.example/api/projects/task4a-final-successor',{method:'POST',body:JSON.stringify({action,digest,confirm:true})}));
 try{
 assert.equal((await post('finance','a'.repeat(64))).status,403);signed=true;
 assert.equal((await post('dispatch','d'.repeat(64))).status,409);
 wip=false;assert.equal((await post('finance','a'.repeat(64))).status,409);wip=true;
 assert.equal((await post('finance','0'.repeat(64))).status,409);
 qualified=false;assert.equal((await post('finance','a'.repeat(64))).status,409);qualified=true;
 assert.equal((await post('finance','a'.repeat(64))).status,200);assert.equal(dispatches,0);
 assert.equal((await post('dispatch','d'.repeat(64))).status,409);
 assert.equal((await post('replacement','b'.repeat(64))).status,200);assert.equal(dispatches,0);
 assert.equal((await post('dispatch','d'.repeat(64))).status,409);
 assert.equal((await post('inference','c'.repeat(64))).status,200);assert.equal(dispatches,0);
 assert.equal((await post('dispatch','d'.repeat(64))).status,200);assert.equal(dispatches,1);
 assert.equal((await post('dispatch','d'.repeat(64))).status,409);assert.equal(dispatches,1);
 assert.deepEqual(writes,['finance','replacement','inference','dispatch']);
 }finally{for(const k of ['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','KATIE_OWNER_AUTH_USER_ID'])if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}
});
test('actual HTTP bridge carries successor envelope to count boundary; overflow never reserves or infers',async()=>{
 let reserved=0,inferred=0,counted=0,input=17915;
 const upstream=Object.assign(async()=>{inferred++;throw Error('fixture must never infer');},{countInputTokens:async body=>{counted++;return {inputTokens:input,requestHash:createHash('sha256').update(JSON.stringify(body)).digest('hex')};}});
 const server=createNativeHttpBridge({db:{rpc:async name=>{if(name==='task4a_native_live')return {data:true};reserved++;return {error:'fixture reservation stop'};}},grantToken:'synthetic-'+('z'.repeat(48)),developerProjectId:envelope.projectId,task4a:true,executionEpoch:4,providerNamespace:'fixture',upperTokens:23034,clientToken:'test-owner-final-token',upstream,recordReceipt:async()=>{},requireInputCount:true,successorEnvelope:envelope});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const post=body=>fetch('http://127.0.0.1:'+server.address().port+'/v1/responses',{method:'POST',headers:{authorization:'Bearer test-owner-final-token','Content-Type':'application/json'},body:JSON.stringify({model:'gpt-5.3-codex',input:'review exact source',...body})});
 try{
 assert.equal((await post({})).status,403);assert.equal(reserved,0);assert.equal(counted,1);
 input=100;assert.equal((await post({max_output_tokens:4097})).status,403);assert.equal(reserved,0);
 input=17914;assert.equal((await post({})).status,403);assert.equal(reserved,1,'Exact boundary reaches original atomic admission, which fixture denies');assert.equal(inferred,0);
 }finally{await new Promise(r=>server.close(r));}
});
