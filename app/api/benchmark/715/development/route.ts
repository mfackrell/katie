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
  const {data,error}=await getSupabaseAdminClient().rpc('benchmark_dashboard_full_task',{p_owner:process.env.KATIE_OWNER_AUTH_USER_ID});
  if(error)return reply({error:'No live benchmark task approval is available.'},409);
  return reply({task:data});
 }catch{return reply({error:'Task approval status is unavailable.'},503)}
}
export async function POST(request:NextRequest){
 try{
  if(!await authenticatedOwner(request)||request.headers.get('origin')!==config.productionUrl)return reply({error:'Approve from your authenticated Katie owner session.'},403);
  const body=await request.json();
  if(body.approve!==true||body.authorization!=='full-task-existing-10usd-350000tokens'||! /^[a-f0-9-]{36}$/.test(body.taskId??'')||! /^[a-f0-9]{64}$/.test(body.scopeHash??''))return reply({error:'Explicit approval of the displayed task and scope is required.'},400);
  const {data,error}=await getSupabaseAdminClient().rpc('benchmark_dashboard_full_task',{p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_task:body.taskId,p_scope:body.scopeHash,p_approve:true});
  if(error)return reply({error:'The task, scope, deadline, or remaining allowance changed. Refresh and review the saved task.'},409);
  return reply({task:data});
 }catch{return reply({error:'Approval could not be saved. Refresh status before retrying.'},503)}
}
