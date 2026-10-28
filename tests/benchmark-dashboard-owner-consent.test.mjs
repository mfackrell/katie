import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import config from '../config/benchmark-715-production-qualification.json' with {type:'json'};
import {sealDashboardHandoff,openDashboardHandoff,validateDashboardConsent} from '../scripts/benchmark/dashboard-owner-consent.mjs';
const key='synthetic-dashboard-key-at-least-32-characters',sha='a'.repeat(40),id='11111111-1111-4111-8111-111111111111';
const payload=()=>({consentId:id,sha,expiresAt:Date.now()+1800000,bypass:'synthetic-vercel-access'});
test('dashboard transport conceals existing credentials and rejects tampering, expiry and another deployment',()=>{
 const p=payload(),sealed=sealDashboardHandoff(p,key);
 assert.ok(!sealed.includes(p.bypass));assert.deepEqual(openDashboardHandoff(sealed,key,sha),p);
 for(const [value,k,s] of [[sealed+'a',key,sha],[sealed,key+'x',sha],[sealed,key,'b'.repeat(40)],[sealDashboardHandoff({...p,expiresAt:Date.now()-1},key),key,sha],[sealDashboardHandoff({...p,expiresAt:Date.now()+7200000},key),key,sha]])assert.throws(()=>openDashboardHandoff(value,k,s),/CONSENT_INVALID/);
});
test('persisted consent requires the authenticated owner, exact deployment and immutable budget statement',()=>{
 const c={id,owner_id:'owner',commit_sha:sha,authorization_sha:config.authorizationBodySha256,run_id:null,expires_at:new Date(Date.now()+10000).toISOString(),revoked_at:null};
 const identity={id,ownerId:'owner',sha,runId:'42',authorizationSha:config.authorizationBodySha256};
 assert.equal(validateDashboardConsent(c,identity),true);
 for(const change of [{owner_id:'other'},{commit_sha:'b'.repeat(40)},{authorization_sha:'wrong'},{run_id:'99'},{revoked_at:new Date().toISOString()},{expires_at:'invalid'},{expires_at:new Date(0).toISOString()}])assert.throws(()=>validateDashboardConsent({...c,...change},identity));
});
const code=ts.transpileModule(readFileSync('app/api/benchmark/715/dashboard/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness({verifiedOwner='owner',preflightError=false,dispatchError=false,dispatchStatus=503}={}){
 const state={consent:null,dispatches:[],mutations:0};
 const db={rpc:async(name,args)=>{
  if(name==='benchmark_prepare_production_owner')return {error:preflightError?{message:'pricing'}:null};
  if(name==='benchmark_record_dashboard_consent'){state.mutations++;if(!state.consent||args.p_renew)state.consent={id,owner_id:args.p_owner,commit_sha:args.p_sha,expires_at:new Date(Date.now()+3595000).toISOString(),dispatch_started_at:null,revoked_at:null};return {data:state.consent,error:null};}
 },from(){
  const filters=[];
  return {select(){return this},order(){return this},limit(){return this},returns:async()=>({data:state.consent?[state.consent]:[],error:null}),eq(k,v){filters.push([k,v]);return this},is(k,v){filters.push([k,v]);return this},
   maybeSingle:async()=>({data:state.consent,error:null}),single:async()=>({data:state.consent,error:null}),
   async insert(p){state.mutations++;if(!state.consent)state.consent={...p,id,expires_at:new Date(Date.now()+3600000-5000).toISOString(),dispatch_started_at:null,revoked_at:null};return {error:null}},
   async updateReturning(p){if(state.consent.dispatch_started_at)return {data:[],error:null};Object.assign(state.consent,p);state.mutations++;return {data:[{id}],error:null}},
   async update(p){Object.assign(state.consent,p);state.mutations++;return {error:null}}
  };
 }};
 const output={};
 vm.runInNewContext(code,{exports:output,AbortSignal,Date,process:{env:{VERCEL_ENV:'production',NEXT_PUBLIC_SUPABASE_URL:config.productionDatabaseUrl,NEXT_PUBLIC_SUPABASE_ANON_KEY:'public',KATIE_OWNER_AUTH_USER_ID:'owner',KATIE_SELF_ACTOR_ID:'actor',VERCEL_GIT_COMMIT_SHA:sha,KATIE_NATIVE_HANDOFF_HMAC_KEY:key,PROJECT_PREVIEW_BYPASS_SECRET:'synthetic-vercel-access',GITHUB_TOKEN:'synthetic-github'}},
  fetch:async(url,options)=>{if(url.endsWith('/auth/v1/user'))return {ok:true,json:async()=>({id:verifiedOwner})};if(options.method==='GET'&&url.endsWith('/pending_deployments'))return {ok:true,json:async()=>state.gates??[]};if(options.method==='GET')return {ok:true,json:async()=>({workflow_runs:state.run?[state.run]:[]})};state.dispatches.push({url,options});return {ok:!dispatchError,status:dispatchStatus};},
  require:name=>name==='next/server'?{NextResponse:{json:(body,options={})=>({body,status:options.status??200})}}:name==='@/lib/data/supabase/admin'?{getSupabaseAdminClient:()=>db}:name.includes('config/')?{default:config}:name.includes('dashboard-owner-consent')?{sealDashboardHandoff}:{}
 });
 return {state,post:(body={approve:true,authorization:'production-715-30usd-350000tokens-4hours',previousConsentId:state.consent?.id??null},headers={authorization:'Bearer owner-session',origin:config.productionUrl})=>output.POST({headers:new Headers(headers),json:async()=>body})};
}
test('dashboard rejects missing/non-owner sessions, cross-origin requests and implicit approvals without writes',async()=>{
 const a=harness();assert.equal((await a.post(undefined,{})).status,403);assert.equal(a.state.mutations,0);
 const b=harness({verifiedOwner:'other'});assert.equal((await b.post()).status,403);assert.equal(b.state.mutations,0);
 const c=harness();assert.equal((await c.post(undefined,{authorization:'Bearer owner-session',origin:'https://other.example'})).status,403);assert.equal(c.state.mutations,0);
 assert.equal((await c.post({approve:false})).status,400);assert.equal(c.state.mutations,0);
 const d=harness({preflightError:true});assert.equal((await d.post()).status,409);assert.equal(d.state.mutations,0);
});
test('explicit dashboard approval persists once and internally dispatches only encrypted transport',async()=>{
 const h=harness();assert.equal((await h.post()).status,200);assert.equal((await h.post()).status,200);
 assert.equal(h.state.dispatches.length,1);assert.equal(h.state.consent.owner_id,'owner');
 const request=JSON.parse(h.state.dispatches[0].options.body);
 assert.equal(request.inputs.authorize,false);assert.equal(request.inputs.dashboard_consent_id,id);
 assert.equal(openDashboardHandoff(request.inputs.dashboard_handoff,key,sha).bypass,'synthetic-vercel-access');
 assert.ok(!h.state.dispatches[0].options.body.includes('synthetic-vercel-access'));
});
test('ambiguous dispatch preserves approval without automatic repeated dispatch or new budgets',async()=>{
 const h=harness({dispatchError:true});assert.equal((await h.post()).status,503);assert.equal((await h.post()).status,200);
 assert.equal(h.state.dispatches.length,1);assert.ok(h.state.consent.dispatch_error);
});

 test('definitively rejected dispatch permits same-consent retry without replacing authority',async()=>{
  const h=harness({dispatchError:true,dispatchStatus:403});assert.equal((await h.post()).status,503);
  const before=h.state.consent;assert.equal(before.dispatch_started_at,null);
  assert.equal((await h.post()).status,503);assert.equal(h.state.consent,before);assert.equal(h.state.dispatches.length,2);
 });
 test('owner reconfirmation after finished failure uses new consent while a running attempt cannot be replaced',async()=>{
  const h=harness();await h.post();const original=h.state.consent;
  h.state.run={id:42,display_title:`Katie benchmark approval ${id}`,head_sha:sha,head_branch:'main',event:'workflow_dispatch',path:config.workflowPath,status:'in_progress',conclusion:null};
  assert.equal((await h.post()).status,200);assert.equal(h.state.consent,original);assert.equal(h.state.dispatches.length,1);
  h.state.run.status='completed';h.state.run.conclusion='failure';
  assert.equal((await h.post()).status,200);assert.notEqual(h.state.consent,original);assert.equal(h.state.dispatches.length,2);
 });

 test('protected execution review requires matching waiting run and existing GitHub permission',async()=>{
  for(const scenario of ['allowed','wrong-gate','not-allowed','not-waiting']){
   const h=harness();await h.post();
   h.state.run={id:42,display_title:`Katie benchmark approval ${id}`,head_sha:sha,head_branch:'main',event:'workflow_dispatch',path:config.workflowPath,status:scenario==='not-waiting'?'in_progress':'waiting',conclusion:null};
   h.state.gates=[{environment:{id:7,name:scenario==='wrong-gate'?'unrelated':'benchmark-paid'},current_user_can_approve:scenario!=='not-allowed'}];
   const r=await h.post({approve:true,authorization:'production-715-30usd-350000tokens-4hours',previousConsentId:id,action:'approveExecutionGate'});
   assert.equal(r.status,scenario==='allowed'?200:scenario==='not-waiting'?409:403);
   assert.equal(h.state.dispatches.length,scenario==='allowed'?2:1);
   if(scenario==='allowed')assert.deepEqual(JSON.parse(h.state.dispatches[1].options.body).environment_ids,[7]);
  }
 });
