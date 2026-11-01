import type {LifecycleSnapshot,LifecycleOffer,LifecycleDecision} from '@/lib/projects/lifecycle-owner-types';
import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {authenticatedLifecycleCheckpoint,prepareLifecycleOwnerProposal,qualifiedDevelopmentAmendmentRelease} from '@/lib/agents/development';
import {digest} from '@/lib/projects/contract';
import config from '@/config/benchmark-715-production-qualification.json';
export const runtime='nodejs';
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store, private'}});
async function owner(request:NextRequest){
 const bearer=request.headers.get('authorization'),url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
 if(!bearer||!/^Bearer [A-Za-z0-9._~-]+$/.test(bearer)||bearer.length>8192||!key||url!==config.productionDatabaseUrl||process.env.VERCEL_ENV!=='production')return null;
 const r=await fetch(url+'/auth/v1/user',{headers:{Authorization:bearer,apikey:key},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});
 if(!r.ok)return null;const user=await r.json();
 return user.is_anonymous!==true&&typeof user.id==='string'&&user.id===process.env.KATIE_OWNER_AUTH_USER_ID?user.id:null;
}
const input=z.object({taskId:z.string().uuid(),proposalId:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(['approved','rejected'])}).strict();
export async function GET(request:NextRequest){
 try{
  const principal=await owner(request);if(!principal)return reply({error:'Sign in as the owner to review resource amendments.'},401);
  const db=getSupabaseAdminClient();
  let taskId=request.nextUrl.searchParams.get('taskId');
  const chatId=request.nextUrl.searchParams.get('chatId');if(chatId&&!z.string().uuid().safeParse(chatId).success)return reply({error:'Invalid conversation.'},400);
  if(taskId&&!z.string().uuid().safeParse(taskId).success)return reply({error:'Invalid task.'},400);
  if(!taskId){let query=db.from('benchmark_native_spending_approvals').select('task_id').eq('owner_id',principal);if(chatId)query=query.eq('chat_id',chatId);
   const recent=await query.order('created_at',{ascending:false}).limit(1).returns<{task_id:string}>();
   if(recent.error)throw Error('Authority unavailable');taskId=recent.data?.[0]?.task_id??null;}
  if(!taskId)return reply({state:'none'});
  const authority=await db.from('benchmark_native_spending_approvals').select('id').eq('owner_id',principal).eq('task_id',taskId).limit(1).returns<{id:string}>();
  if(authority.error||!authority.data?.length)return reply({error:'Task ownership denied.'},403);
  let result=await db.from('benchmark_lifecycle_proposals').select('*').eq('owner_id',principal).eq('task_id',taskId).order('created_at',{ascending:false}).limit(1).returns<LifecycleOffer>();
  if(result.error)throw Error('Proposal records unavailable');
  const task=await db.from('agent_tasks').select('status').eq('id',taskId).maybeSingle<{status:string}>();
  if(task.error)throw Error('Task state unavailable');
  if(task.data?.status==='blocked'){
   const current=await db.rpc<LifecycleSnapshot>('benchmark_lifecycle_snapshot',{p_task:taskId});
   if(current.error)throw Error('Current authority unavailable');
   if(!result.data?.length||request.nextUrl.searchParams.get('refresh')==='true'||current.data?.snapshotHash!==result.data[0].snapshot_hash){
    const prepared=await prepareLifecycleOwnerProposal(taskId);
    if('offer' in prepared&&prepared.offer)result={data:[prepared.offer],error:null};
    else if(!result.data?.length)return reply({...prepared,taskId});
   }
  }
  const offer=result.data?.[0];if(!offer)return reply({state:'none',taskId});
  const decision=await db.from('benchmark_lifecycle_decisions').select('*').eq('proposal_id',offer.id).maybeSingle<LifecycleDecision>();
  if(decision.error)throw Error('Decision unavailable');
  if(decision.data){
   let state:string=decision.data.decision;
   if(state==='approved'){
    const grants=await db.from('benchmark_execution_grants').select('id').eq(decision.data.developer_approval_id?'developer_approval_id':'continuation_id',decision.data.developer_approval_id??decision.data.continuation_id).limit(1).returns<{id:string}>();
    const task=await db.from('agent_tasks').select('status').eq('id',taskId).maybeSingle<{status:string}>();
    if(task.data?.status==='blocked')state='continuation_failed';
    else if(grants.data?.length)state='resumed';
   }
   return reply({state,taskId,proposal:offer.proposal,decision:decision.data});
  }
  let state=Date.parse(offer.expires_at)<=Date.now()?'expired':'pending';
  if(state==='pending'){const current=await db.rpc<LifecycleSnapshot>('benchmark_lifecycle_snapshot',{p_task:taskId});if(current.error||current.data?.snapshotHash!==offer.snapshot_hash)state='stale';}
  return reply({state,taskId,proposal:offer.proposal});
 }catch{return reply({error:'Resource approval evidence is unavailable. Saved work and spending authority are unchanged.',state:'evidence_required'},409);}
}
export async function POST(request:NextRequest){
 try{
  const principal=await owner(request);if(!principal)return reply({error:'Authenticated owner required.'},403);
  if(request.headers.get('origin')!==config.productionUrl)return reply({error:'Approve from the Katie production application.'},403);
  const parsed=input.safeParse(await request.json());if(!parsed.success)return reply({error:'Exact proposal and explicit decision required.'},400);
  const {taskId,proposalId,decision}=parsed.data,db=getSupabaseAdminClient();
  const saved=await db.from('benchmark_lifecycle_proposals').select('*').eq('id',proposalId).eq('owner_id',principal).eq('task_id',taskId).maybeSingle<LifecycleOffer>();
  if(saved.error||!saved.data)return reply({error:'Proposal ownership denied.'},403);
  const prior=await db.from('benchmark_lifecycle_decisions').select('*').eq('proposal_id',proposalId).maybeSingle<LifecycleDecision>();
  if(prior.error)throw Error('Decision unavailable');
  if(prior.data){if(prior.data.decision!==decision)return reply({error:'Proposal already decided.'},409);return reply({state:decision,decision:prior.data});}
  if(Date.parse(saved.data.expires_at)<=Date.now())return reply({error:'Proposal expired. Review a refreshed proposal.',state:'expired'},409);
  if(decision==='approved'){
   const evidence=await authenticatedLifecycleCheckpoint(taskId);
   if(evidence.snapshot.ownerId!==principal||evidence.snapshot.snapshotHash!==saved.data.snapshot_hash||digest(evidence.checkpoint)!==digest(saved.data.checkpoint))
    return reply({error:'Task, accounting or latest checkpoint changed. Refresh the proposal.',state:'stale'},409);
  }
  const release=decision==='approved'?await qualifiedDevelopmentAmendmentRelease():null;if(decision==='approved'&&!release)return reply({error:'The deployed amendment runtime is not qualified.'},409);
  const committed=await db.rpc('benchmark_lifecycle_decide',{p_owner:principal,p_task:taskId,p_proposal:proposalId,p_decision:decision,p_release:release});
  if(committed.error)return reply({error:'The proposal became stale, expired, or its authority is unavailable. Refresh before deciding again.',state:'stale'},409);
  return reply(committed.data);
 }catch{return reply({error:'Decision could not be confirmed. Refresh status before retrying; do not assume authorization succeeded.'},503);}
}
