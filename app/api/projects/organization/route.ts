import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';
import {rpc} from '@/lib/missions/store';
import {getMessages} from '@/lib/data/persistence-store';
const financialInput=z.object({projectId:z.string().uuid(),autonomousExecution:z.literal(true),objectiveHash:z.string().regex(/^[a-f0-9]{64}$/),ceilingMicrousd:z.number().int().positive().max(1_000_000_000),perCallMicrousd:z.number().int().positive()}).strict();
const providerTrialInput=z.object({actorId:z.string().uuid(),chatId:z.string().uuid(),trialAction:z.enum(['start','stop'])}).strict();
const input=z.union([financialInput,providerTrialInput]);
// Neither workers nor cron can activate either kind of owner authority.
export async function POST(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return NextResponse.json({error:'Authenticated owner session required'},{status:403});
 const parsed=input.safeParse(await request.json().catch(()=>null));
 if(!parsed.success)return NextResponse.json({error:'Invalid project authority request'},{status:400});
 const p=parsed.data;
 try{
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
