import {NextRequest,NextResponse} from 'next/server';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import config from '@/config/benchmark-715-production-qualification.json';
import {readQualification,verifyOwnerRun} from '../../../../../scripts/benchmark/production-owner-qualification.mjs';
export const runtime='nodejs';
export const maxDuration=60;
const ready=()=>process.env.VERCEL_ENV==='production'&&
 process.env.NEXT_PUBLIC_SUPABASE_URL===config.productionDatabaseUrl&&
 (!process.env.SUPABASE_URL||process.env.SUPABASE_URL===config.productionDatabaseUrl)&&
 !!process.env.KATIE_NATIVE_HANDOFF_HMAC_KEY&&!!process.env.GITHUB_TOKEN&&
 !!process.env.KATIE_OWNER_AUTH_USER_ID&&!!process.env.KATIE_SELF_ACTOR_ID;
// Readiness only; this GET cannot qualify an owner or create any records.
export async function GET(){
 if(!ready())return NextResponse.json({error:'Production qualification configuration unavailable'},{status:503});
 const {error}=await getSupabaseAdminClient().from('benchmark_production_qualifications').select('issue').limit(1);
 if(error)return NextResponse.json({error:'Production qualification migration unavailable'},{status:503});
 return NextResponse.json({issue:715,commitSha:process.env.VERCEL_GIT_COMMIT_SHA,ready:true},{headers:{'Cache-Control':'no-store'}});
}
export async function POST(request:NextRequest){
 if(!ready())return NextResponse.json({error:'Production qualification configuration unavailable'},{status:503});
 try{
  if(Number(request.headers.get('content-length')||0)>16000)throw Error('size');
  const text=await request.text();
  const payload=readQualification(text,process.env.KATIE_NATIVE_HANDOFF_HMAC_KEY);
  const github=async(path:string)=>{
   const r=await fetch(`https://api.github.com/repos/${config.repository}/${path}`,{
    headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
    signal:AbortSignal.timeout(8000),cache:'no-store',redirect:'error'});
   if(!r.ok)throw Error('GitHub evidence unavailable');
   return r.json();
  };
  const [run,comment,jobs,checks]=await Promise.all([
   github(`actions/runs/${payload.runId}/attempts/${payload.runAttempt}`),
   github(`issues/comments/${config.authorizationCommentId}`),
   github(`actions/runs/${payload.runId}/attempts/${payload.runAttempt}/jobs?per_page=100`),
   github(`actions/runs?head_sha=${payload.sha}&per_page=100`)
  ]);
  const workflow=await github(`actions/workflows/${run.workflow_id}`);
  verifyOwnerRun({payload,run,comment,workflow,checks:checks.workflow_runs,jobs:jobs.jobs,
   deployedSha:process.env.VERCEL_GIT_COMMIT_SHA,config});
  if(payload.phase==='prepare'){
   const {error}=await getSupabaseAdminClient().rpc('benchmark_prepare_production_owner',{
    p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_actor:process.env.KATIE_SELF_ACTOR_ID
   });
   if(error)return NextResponse.json({error:'Production price, identity or ledger preflight refused'},{status:409});
   return NextResponse.json({ready:true,commitSha:payload.sha},{headers:{'Cache-Control':'no-store'}});
  }
  const {data,error}=await getSupabaseAdminClient().rpc('benchmark_qualify_production_owner',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_actor:process.env.KATIE_SELF_ACTOR_ID,
   p_run:payload.runId,p_sha:payload.sha,p_transfer:payload.transfer,p_protocol:config.protocol
  });
  if(error)return NextResponse.json({error:'Production ledger qualification refused; preserve the transfer receipt and retry the same workflow.'},{status:409});
  return NextResponse.json(data,{headers:{'Cache-Control':'no-store'}});
 }catch{
  return NextResponse.json({error:'Authenticated owner qualification evidence unavailable or invalid'},{status:403});
 }
}
