import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';
import {rpc} from '@/lib/missions/store';
import {getMessages} from '@/lib/data/persistence-store';
const financialInput=z.object({projectId:z.string().uuid(),autonomousExecution:z.literal(true),objectiveHash:z.string().regex(/^[a-f0-9]{64}$/),ceilingMicrousd:z.number().int().positive().max(1_000_000_000),perCallMicrousd:z.number().int().positive()}).strict();
const providerTrialInput=z.object({actorId:z.string().uuid(),chatId:z.string().uuid(),trialAction:z.enum(['start','stop'])}).strict();
const directorRecoveryInput=z.object({
 projectId:z.string().uuid(),trialAction:z.literal('recover_director_once'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),cutoff:z.string().datetime({offset:true}),
 priorCutoff:z.string().datetime({offset:true}).optional(),
}).strict();
const continuationInput=z.object({projectId:z.string().uuid(),trialAction:z.literal('continue'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),decisionId:z.string().uuid(),cutoff:z.string().datetime({offset:true})}).strict();
const renewalInput=continuationInput.extend({trialAction:z.literal('renew_continue'),
 priorCutoff:z.string().datetime({offset:true}),authorizationId:z.string().uuid()}).strict();
const input=z.union([financialInput,providerTrialInput,directorRecoveryInput,continuationInput,renewalInput]);
// Neither workers nor cron can activate either kind of owner authority.
export async function POST(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return NextResponse.json({error:'Authenticated owner session required'},{status:403});
 const parsed=input.safeParse(await request.json().catch(()=>null));
 if(!parsed.success)return NextResponse.json({error:'Invalid project authority request'},{status:400});
 const p=parsed.data;
 try{
 if('trialAction' in p&&(p.trialAction==='continue'||p.trialAction==='renew_continue')){
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
   return NextResponse.json({error:'Continuation requires the exact active production release'},{status:409});
  const args={p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_release:p.releaseSha,p_decision:p.decisionId,p_cutoff:p.cutoff};
  return NextResponse.json(p.trialAction==='renew_continue'
   ?await rpc('project_org_renew_continue',{...args,p_prior_cutoff:p.priorCutoff,p_authorization:p.authorizationId})
   :await rpc('project_provider_continue',args));
 }
 if('trialAction' in p&&p.trialAction==='recover_director_once'){
  if(p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)return NextResponse.json({error:'Recovery requires the exact active production release'},{status:409});
  const args={p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_release:p.releaseSha,p_cutoff:p.cutoff};
  const admission=p.priorCutoff
   ?await rpc('project_admit_expired_director_recovery',{...args,p_prior_cutoff:p.priorCutoff})
   :await rpc('project_admit_director_recovery',args);
  return NextResponse.json(admission);
 }
 if('trialAction' in p){
  const project=await rpc<{id:string;status:string}>(
   p.trialAction==='start'?'project_provider_launch':'project_provider_owner_stop',
   {p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_actor:p.actorId,p_chat:p.chatId});
  return NextResponse.json({projectId:project.id,status:project.status,messages:await getMessages(p.chatId).catch(()=>undefined)});
 }
 await rpc('project_org_authorize',{p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_objective_hash:p.objectiveHash,p_ceiling:p.ceilingMicrousd,p_per_call:p.perCallMicrousd,p_autonomous:p.autonomousExecution});
 return NextResponse.json({authorized:true});
 }catch{return NextResponse.json({error:'Owner binding, project objective or execution authority changed'},{status:409});}
}
