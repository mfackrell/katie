import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';
import {rpc} from '@/lib/missions/store';
const input=z.object({projectId:z.string().uuid(),objectiveHash:z.string().regex(/^[a-f0-9]{64}$/),ceilingMicrousd:z.number().int().positive().max(1_000_000_000),perCallMicrousd:z.number().int().positive()}).strict();
// Original project financial consent only. Neither workers nor cron call this endpoint.
export async function POST(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return NextResponse.json({error:'Authenticated owner session required'},{status:403});
 const parsed=input.safeParse(await request.json().catch(()=>null));
 if(!parsed.success)return NextResponse.json({error:'Invalid project financial authority'},{status:400});
 const p=parsed.data;
 try{
 await rpc('project_org_authorize',{p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_objective_hash:p.objectiveHash,p_ceiling:p.ceilingMicrousd,p_per_call:p.perCallMicrousd});
 return NextResponse.json({authorized:true});
 }catch{return NextResponse.json({error:'Owner binding, objective or financial authority changed'},{status:409});}
}
