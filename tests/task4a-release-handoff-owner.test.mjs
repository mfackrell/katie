import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const owner='04ed6c05-a586-4a56-ba81-1b50e378746b';
const release='e'.repeat(40),digest='d'.repeat(64);
const url='https://katie.local/api/projects/task4a-postpaid-continuation';
const chat='e53defeb-16eb-457e-aa07-435141165ee8';

test('release-SHA handoff requires one new owner click, reuses paid receipt and never creates a new budget',async()=>{
 const prior={owner:process.env.KATIE_OWNER_AUTH_USER_ID,
  vercel:process.env.VERCEL_ENV,sha:process.env.VERCEL_GIT_COMMIT_SHA};
 process.env.KATIE_OWNER_AUTH_USER_ID=owner;process.env.VERCEL_ENV='production';
 process.env.VERCEL_GIT_COMMIT_SHA=release;
 let signed=false,handoff=false,claimed=false,dispatches=0,authorizations=0,newBudgets=0;
 const events=()=>[
  {id:'owner-existing',event:'task4a_postpaid_owner_authorized',data:{ownerId:owner}},
  {id:'redispatch-existing',event:'task4a_postpaid_redispatch_authorized',data:{ownerId:owner}},
  {id:'paid-existing',event:'task4a_postpaid_paid_authorized',data:{ownerId:owner}},
  ...(handoff?[{id:'release-handoff-1',event:'task4a_postpaid_release_handoff_authorized',data:{ownerId:owner}}]:[]),
  ...(claimed?[{id:'original-claim',event:'task4a_postpaid_dispatch_claimed',data:{ownerId:owner}}]:[])
 ];
 const db={from:table=>{
  assert.equal(table,'project_events');
  return{select:()=>({eq:()=>({in:()=>({returns:async()=>({data:events(),error:null})})})})};
 },rpc:async(name,args)=>{
  assert.equal(args.p_release,release);
  if(name==='task4a_postpaid_release_handoff_proposal')return {
   data:{ready:!handoff,digest,proposal:{ownerId:owner,releaseSha:release,
    priorReleaseSha:'2147b910ad7bba849e8f4de7cf91f36a3410595e',
    noNewFinancialAuthority:true}},error:null};
  assert.equal(name,'task4a_postpaid_release_handoff_authorize');
  assert.equal(args.p_owner,owner);assert.equal(args.p_digest,digest);
  assert.equal(handoff,false);handoff=true;authorizations++;
  return{data:{authorized:true,receiptId:'release-handoff-1',newPaidCalls:0,
   newFinancialAuthority:false,dispatched:false},error:null};
 }};
 const {GET,POST}=modules({
  'next/server':{NextResponse:{json:(body,opts)=>Response.json(body,opts)}},
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>signed},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},
  '@/lib/agents/development':{
   qualifiedOrdinaryDevelopmentRelease:async()=>release,
   dispatchTask4aPostpaidOnce:async()=>{dispatches++;claimed=true;return true;},
   authenticatedLifecycleCheckpoint:async()=>{throw Error('Prior verified WIP must not be reread for a release handoff');}
  },
  '@/lib/projects/contract':{digest:()=>digest}
 })('@/app/api/projects/task4a-postpaid-continuation/route');
 const get=()=>GET(new Request(url+'?chatId='+chat));
 const post=body=>POST(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify(body)}));
 try{
  assert.equal((await get()).status,401);
  assert.equal((await post({action:'approveReleaseHandoff',digest,confirm:true})).status,403);
  signed=true;
  const quote=await(await get()).json();
  assert.equal(quote.state,'pending_release_handoff');
  assert.equal(quote.nextAction,'approveReleaseHandoff');
  assert.equal(quote.digest,digest);
  assert.equal(quote.paidReceiptId,'paid-existing');
  assert.equal(dispatches,0);assert.equal(authorizations,0);
  assert.equal((await post({action:'approvePaidInference',digest,confirm:true})).status,409);
  assert.equal((await post({action:'approveReleaseHandoff',digest:'0'.repeat(64),confirm:true})).status,409);
  assert.equal(dispatches,0);assert.equal(authorizations,0);
  const decision=await post({action:'approveReleaseHandoff',digest,confirm:true});
  assert.equal(decision.status,200);
  const body=await decision.json();
  assert.equal(body.stage,'releaseHandoff');
  assert.equal(body.dispatchAccepted,true);
  assert.equal(body.noNewFinancialAuthority,true);
  assert.equal(body.newPaidCalls,0);
  assert.equal(authorizations,1);assert.equal(dispatches,1);assert.equal(newBudgets,0);
  const repeated=await post({action:'approveReleaseHandoff',digest,confirm:true});
  assert.equal(repeated.status,409);assert.equal(authorizations,1);assert.equal(dispatches,1);
  const after=await(await get()).json();
  assert.equal(after.state,'claimed_once');
  assert.equal(after.paidReceiptId,'paid-existing');
  assert.equal(after.claimReceiptId,'original-claim');
 }finally{
  for(const [k,v] of Object.entries({KATIE_OWNER_AUTH_USER_ID:prior.owner,
   VERCEL_ENV:prior.vercel,VERCEL_GIT_COMMIT_SHA:prior.sha}))
   if(v===undefined)delete process.env[k];else process.env[k]=v;
 }
});
