import {qualifiedDevelopmentAmendmentRelease} from '@/lib/agents/development';
import {NextRequest,NextResponse} from 'next/server';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import config from '@/config/benchmark-715-production-qualification.json';
export const runtime='nodejs';
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
async function authenticatedOwner(request:NextRequest){
 const bearer=request.headers.get('authorization'),url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
 if(!bearer||!/^Bearer [A-Za-z0-9._~-]+$/.test(bearer)||bearer.length>8192||process.env.VERCEL_ENV!=='production'||url!==config.productionDatabaseUrl||!key||!process.env.KATIE_OWNER_AUTH_USER_ID)return false;
 const r=await fetch(url+'/auth/v1/user',{headers:{Authorization:bearer,apikey:key},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});
 return r.ok&&(await r.json()).id===process.env.KATIE_OWNER_AUTH_USER_ID;
}
export async function GET(request:NextRequest){
 try{
  if(!await authenticatedOwner(request))return reply({error:'Sign in to Katie as the owner.'},401);
  const release=await qualifiedDevelopmentAmendmentRelease();
  if(release){
   const amendment=await getSupabaseAdminClient().rpc('benchmark_dashboard_development_amendment',{p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_release:release,p_runtime:'provider-input-count-v1'});
   if(amendment.error)return reply({error:'Resource amendment status is unavailable.'},409);
   if(amendment.data)return reply({continuation:amendment.data});
  }
  const {data,error}=await getSupabaseAdminClient().rpc('benchmark_dashboard_continuation',{p_owner:process.env.KATIE_OWNER_AUTH_USER_ID});
  if(error)return reply({error:'No live benchmark continuation approval is available.'},409);
  return reply({continuation:data});
 }catch{return reply({error:'Continuation approval status is unavailable.'},503)}
}
export async function POST(request:NextRequest){
 try{
  if(!await authenticatedOwner(request)||request.headers.get('origin')!==config.productionUrl)return reply({error:'Approve from your authenticated Katie owner session.'},403);
  const body=await request.json();
  if(body.authorization==='full-development-resource-amendment-550000tokens-10usd-4hours'){
   if(body.approve!==true||! /^[a-f0-9-]{36}$/.test(body.projectId??'')||! /^[a-f0-9]{64}$/.test(body.planHash??''))return reply({error:'Explicit approval of the displayed resource amendment is required.'},400);
   const release=await qualifiedDevelopmentAmendmentRelease();if(!release)return reply({error:'Verified count-aware runtime is not available.'},409);
   const {data,error}=await getSupabaseAdminClient().rpc('benchmark_dashboard_development_amendment',{p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:body.projectId,p_plan_hash:body.planHash,p_approve:true,p_release:release,p_runtime:'provider-input-count-v1'});
   if(error)return reply({error:'The displayed amendment changed or expired. Refresh and review it before approving.'},409);
   return reply({continuation:data});
  }
  if(body.approve!==true||!['full-continuation-existing-budget-270000tokens-4hours','full-continuation-displayed-plan-existing-budget-4hours'].includes(body.authorization)||! /^[a-f0-9-]{36}$/.test(body.projectId??'')||! /^[a-f0-9]{64}$/.test(body.planHash??''))return reply({error:'Explicit approval of the displayed continuation plan is required.'},400);
  const {data,error}=await getSupabaseAdminClient().rpc('benchmark_dashboard_continuation',{p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:body.projectId,p_plan_hash:body.planHash,p_approve:true});
  if(error)return reply({error:'The checkpoint, plan, deadline, or remaining allowance changed. Refresh and review the saved continuation plan.'},409);
  return reply({continuation:data});
 }catch{return reply({error:'Approval could not be saved. Refresh status before retrying.'},503)}
}

