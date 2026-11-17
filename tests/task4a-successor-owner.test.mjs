import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const original='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const owner='04ed6c05-a586-4a56-ba81-1b50e378746b';
const digest='a'.repeat(64);
const limits={tokens:300000,calls:30,dollarsCents:800,assessmentTokens:60000,
 completionTokens:60000,assessmentCalls:6,completionCalls:6,seconds:3600,
 models:['openai:gpt-5.3-codex']};

test('successor authorization uses separate preview, authenticated owner and exact digest',async()=>{
 const savedOwnerEnv=process.env.KATIE_OWNER_AUTH_USER_ID;
 process.env.KATIE_OWNER_AUTH_USER_ID=owner;
 let signed=false,created=0,valid=true,ownerAvailable=true;
 const proposal={ready:true,digest,proposal:{ownerId:owner,
  predecessorId:'405ea82c-6f52-49e5-babf-891ecac64d14',
  incrementalTokens:300000,incrementalCalls:30,incrementalMicrousd:8000000}};
 const db={
  rpc:async(name,args)=>{
   if(name==='task4a_successor_proposal'){
    if(args.p_tokens===0)return {data:{ready:false,reason:'owner_limits_required',
     ledger:{ownerId:owner,historicalCalls:25,historicalActualTokens:147102,
      historicalCallReservedTokens:213764,historicalReservedExposureMicrousd:4086819,
      maximumNewTokens:386236}},error:null};
    assert.equal(args.p_tokens,300000);
    assert.equal(args.p_money,8000000);
    assert.equal(args.p_seconds,3600);
    return {data:valid?proposal:{ready:false,reason:'stale'},error:null};
   }
   if(name==='task4a_original_owner_id')return {data:ownerAvailable?owner:null,error:null};
   assert.equal(name,'task4a_authorize_successor');
   assert.equal(args.p_owner,owner);
   assert.equal(args.p_digest,digest);
   assert.equal(args.p_calls,30);
   created++;valid=false;
   return {data:{authorized:true,authorizationId:'new-successor',receiptId:'receipt'},error:null};
  },
  from:name=>{
   assert.equal(name,'work_projects');
   return {select:()=>({eq:(column,id)=>({
    maybeSingle:async()=>{
     assert.equal(column,'id');
     assert.equal(id,original);
     return {data:{actor_id:'actor',chat_id:'chat'},error:null};
    }
   })})};
  }
 };
 const {GET,POST}=modules({
  'next/server':{NextResponse:{json:(body,opts)=>Response.json(body,opts)}},
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>signed},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db}
 })('@/app/api/projects/task4a-successor/route');
 const get=()=>GET(new Request('https://katie.local/api/projects/task4a-successor'));
 const post=body=>POST(new Request('https://katie.local/api/projects/task4a-successor',{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
 assert.equal((await get()).status,401);
 assert.equal((await post({action:'propose',limits})).status,403);
 signed=true;
 const before=await get();
 assert.equal(before.status,200);
 assert.equal((await before.json()).readiness.ledger.historicalActualTokens,147102);
 assert.equal((await post({action:'propose',limits:{...limits,dollarsCents:-1}})).status,400);
 const preview=await post({action:'propose',limits});
 assert.equal(preview.status,200);
 assert.equal((await preview.json()).digest,digest);
 assert.equal(created,0,'Preview must never create owner authority');
 assert.equal((await post({action:'approve',limits,digest:'f'.repeat(64)})).status,409);
 assert.equal(created,0,'Mismatched digest cannot create authority');
 ownerAvailable=false;
 assert.equal((await post({action:'approve',limits,digest})).status,403);
 assert.equal(created,0,'Owner binding must be verified');
 ownerAvailable=true;
 process.env.KATIE_OWNER_AUTH_USER_ID='99999999-9999-4999-8999-999999999999';
 assert.equal((await get()).status,403,'Unrelated signed installation-owner session cannot see original ledger');
 assert.equal((await post({action:'propose',limits})).status,403,'Cannot show grant to unrelated session owner');
 assert.equal((await post({action:'approve',limits,digest})).status,403,'Cannot approve someone else’s original project');
 assert.equal(created,0);
 process.env.KATIE_OWNER_AUTH_USER_ID=owner;
 const approved=await post({action:'approve',limits,digest});
 assert.equal(approved.status,200);
 assert.equal((await approved.json()).originalTaskStillBlocked,true);
 assert.equal(created,1);
 assert.equal((await post({action:'approve',limits,digest})).status,409);
 assert.equal(created,1,'No replay or duplicate successor');
 if(savedOwnerEnv===undefined)delete process.env.KATIE_OWNER_AUTH_USER_ID;
 else process.env.KATIE_OWNER_AUTH_USER_ID=savedOwnerEnv;
});
