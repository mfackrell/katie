import {NextRequest,NextResponse} from 'next/server';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import config from '@/config/benchmark-715-production-qualification.json';
import {sealDashboardHandoff} from '../../../../../scripts/benchmark/dashboard-owner-consent.mjs';
export const runtime='nodejs';
export const maxDuration=60;
type Consent={id:string;owner_id:string;commit_sha:string;created_at:string;expires_at:string;dispatch_started_at:string|null;dispatch_error:string|null;run_id:string|null;revoked_at:string|null};
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
async function owner(request:NextRequest){
 const bearer=request.headers.get('authorization');
 if(!bearer||!/^Bearer [A-Za-z0-9._~-]+$/.test(bearer)||bearer.length>8192)return false;
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
 if(process.env.VERCEL_ENV!=='production'||url!==config.productionDatabaseUrl||!key||!process.env.KATIE_OWNER_AUTH_USER_ID)return false;
 const r=await fetch(url+'/auth/v1/user',{headers:{Authorization:bearer,apikey:key},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});
 return r.ok&&(await r.json()).id===process.env.KATIE_OWNER_AUTH_USER_ID;
}
async function github(path:string,body?:unknown){
 const r=await fetch(`https://api.github.com/repos/${config.repository}/${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
 return r;
}
async function latest(){
 const r=await getSupabaseAdminClient().from('benchmark_dashboard_owner_consents').select('*').eq('issue',715).order('created_at',{ascending:false}).limit(1).returns<Consent>();
 if(r.error)throw Error('consent read');return r.data?.[0]??null;
}
async function execution(consent:Consent|null){
 if(!consent?.dispatch_started_at)return null;
 const path=consent.run_id?`actions/runs/${consent.run_id}`:`actions/workflows/${config.workflowPath.split('/').pop()}/runs?event=workflow_dispatch&per_page=100`;
 const r=await github(path);if(!r.ok)throw Error('execution read');
 const result=await r.json();
 const run=consent.run_id?result:result.workflow_runs?.find((x:{display_title:string;head_sha:string})=>x.display_title===`Katie benchmark approval ${consent.id}`&&x.head_sha===consent.commit_sha);
 if(!run)return null;
 if(run.head_sha!==consent.commit_sha||run.head_branch!=='main'||run.event!=='workflow_dispatch'||run.path!==config.workflowPath)throw Error('execution identity');
 return {id:String(run.id),status:String(run.status),conclusion:run.conclusion as string|null};
}
export async function GET(request:NextRequest){
 try{
  if(!await owner(request))return reply({error:'Sign in to Katie as the owner to review this approval.'},401);
  const [consent,qualification]=await Promise.all([latest(),getSupabaseAdminClient().from('benchmark_production_qualifications').select('experiment_id,deadline,owner_run_id,revoked_at').eq('issue',715).maybeSingle()]);
  if(qualification.error)throw Error('qualification read');
  const run=await execution(consent);
  return reply({consent,qualification:qualification.data,execution:run,canRetry:!!consent&&(!consent.dispatch_started_at||run?.status==='completed'||(!run&&Date.parse(consent.expires_at)<=Date.now())),deploymentChanged:!!consent&&consent.commit_sha!==process.env.VERCEL_GIT_COMMIT_SHA});
 }catch{return reply({error:'Benchmark approval status is temporarily unavailable.'},503)}
}
export async function POST(request:NextRequest){
 try{
  if(!await owner(request))return reply({error:'An authenticated Katie owner session is required.'},403);
  if(request.headers.get('origin')!==config.productionUrl)return reply({error:'Open this approval in Katie.'},403);
  const body=await request.json();
  if(body?.authorization!=='production-715-30usd-350000tokens-4hours'||body?.approve!==true)return reply({error:'Explicit approval of the displayed limits is required.'},400);
  const sha=process.env.VERCEL_GIT_COMMIT_SHA,hmac=process.env.KATIE_NATIVE_HANDOFF_HMAC_KEY;
  const bypass=process.env.PROJECT_PREVIEW_BYPASS_SECRET||process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if(!sha||! /^[a-f0-9]{40}$/.test(sha)||!hmac||hmac.length<32||!bypass||!process.env.GITHUB_TOKEN)return reply({error:'Katie’s internal execution connection is unavailable. No budget has been transferred.'},503);
  const db=getSupabaseAdminClient(),previous=await latest();
  if((previous?.id??null)!==(body.previousConsentId??null))return reply({approved:true,alreadySubmitted:true});
  const run=await execution(previous);
  if(body.action==='approveExecutionGate'){
   if(!previous||!run||run.status!=='waiting'||previous.revoked_at)return reply({error:'There is no matching execution gate awaiting approval.'},409);
   const r=await github(`actions/runs/${run.id}/pending_deployments`);if(!r.ok)throw Error('gate read');
   const gates=await r.json();const gate=gates.find((x:{environment?:{name:string};current_user_can_approve:boolean})=>x.environment?.name==='benchmark-paid'&&x.current_user_can_approve);
   if(!gate)return reply({error:'The configured execution identity cannot approve this protected gate. Its protection has been preserved.'},403);
   const approved=await github(`actions/runs/${run.id}/pending_deployments`,{environment_ids:[gate.environment.id],state:'approved',comment:`Explicit Katie dashboard owner approval ${previous.id}`});
   if(!approved.ok)throw Error('gate approve');return reply({approved:true});
  }
  if(previous?.dispatch_started_at&&run?.status!=='completed'&&!(!run&&Date.parse(previous.expires_at)<=Date.now()))return reply({approved:true,alreadySubmitted:true});
  const {error:preflight}=await db.rpc('benchmark_prepare_production_owner',{p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_actor:process.env.KATIE_SELF_ACTOR_ID});
  if(preflight)return reply({error:'The existing budget or model-price verification requires attention. No new allowance was created.'},409);
  // Owner reconfirms after a failed run or corrected deployment. Original transfer,
  // account spending and deadline remain immutable in the existing qualifier.
  const renew=!!previous&&(previous.commit_sha!==sha||Date.parse(previous.expires_at)<=Date.now()||previous.revoked_at!==null||run?.status==='completed');
  const recorded=await db.rpc<Consent>('benchmark_record_dashboard_consent',{p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_sha:sha,p_previous:previous?.id??null,p_renew:renew});
  if(recorded.error||!recorded.data)throw Error('consent save');const consent=recorded.data;
  if(consent.owner_id!==process.env.KATIE_OWNER_AUTH_USER_ID||consent.commit_sha!==sha||consent.revoked_at||Date.parse(consent.expires_at)<=Date.now())return reply({error:'The saved approval cannot authorize this deployment.'},409);
  if(consent.dispatch_started_at)return reply({approved:true,alreadySubmitted:true});
  const {data:claim,error:claimError}=await db.from('benchmark_dashboard_owner_consents').eq('id',consent.id).is('dispatch_started_at',null).updateReturning<{id:string}>({dispatch_started_at:new Date().toISOString(),dispatch_error:null},'id');
  if(claimError)throw Error('dispatch claim');if(!claim?.length)return reply({approved:true,alreadySubmitted:true});
  const encrypted=sealDashboardHandoff({consentId:consent.id,sha,expiresAt:Date.parse(consent.expires_at),bypass},hmac);
  try{
   const r=await github(`actions/workflows/${config.workflowPath.split('/').pop()}/dispatches`,{ref:'main',inputs:{authorize:false,dashboard_consent_id:consent.id,dashboard_handoff:encrypted}});
   if(!r.ok){
    // Explicit rejection means no run was accepted; retain consent and allow retry.
    const rejected=[400,401,403,404,422,429].includes(r.status);
    await db.from('benchmark_dashboard_owner_consents').eq('id',consent.id).update({...(rejected?{dispatch_started_at:null}:{}),dispatch_error:rejected?'Execution connection rejected the launch. Retry retains the same approval and budget.':'Execution launch needs reconciliation; saved approval and spending limits preserved.'});
    return reply({error:rejected?'Your approval is saved, but the execution connection rejected launch. Retry after the connection is corrected.':'Your approval is saved. Execution launch needs reconciliation before retrying.'},503);
   }
  }catch{
   await db.from('benchmark_dashboard_owner_consents').eq('id',consent.id).update({dispatch_error:'Execution launch needs reconciliation; saved approval and spending limits preserved.'});
   return reply({error:'Your approval is saved. Katie’s execution launch needs reconciliation; do not approve a replacement budget.'},503);
  }
  return reply({approved:true});
 }catch{return reply({error:'Could not complete the approval request. Check its saved status before retrying.'},503)}
}
