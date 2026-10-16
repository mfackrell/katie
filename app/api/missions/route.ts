import { NextRequest,NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import { readMission,rpc } from '@/lib/missions/store';
const create=z.object({action:z.literal('create'),id:z.string().uuid(),objective:z.string().trim().min(1).max(12000),agents:z.array(z.string().uuid()).min(1).max(3),minutes:z.number().int().min(5).max(120),repositoryId:z.string().uuid().optional()}).strict();
const control=z.object({action:z.enum(['start','stop','approve']),id:z.string().uuid(),jobId:z.string().uuid().optional()}).strict();
export async function GET(request:NextRequest){
 try{
  const id=request.nextUrl.searchParams.get('id');
  if(id)return NextResponse.json(await readMission(z.string().uuid().parse(id)),{headers:{'Cache-Control':'no-store'}});
  const {data,error}=await getSupabaseAdminClient().from('agent_missions').select('*').order('created_at',{ascending:false}).limit(50);
  if(error)throw Error('Mission history unavailable');
  return NextResponse.json({missions:data},{headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:'Mission history unavailable'},{status:503});}
}
export async function POST(request:NextRequest){
 try{
  const raw=await request.json();
  if(raw.action==='create'){const b=create.parse(raw);return NextResponse.json({mission:await rpc('create_mission',{p_id:b.id,p_objective:b.objective,p_agents:b.agents,p_minutes:b.minutes,p_repository:b.repositoryId??null})});}
  const b=control.parse(raw);
  return NextResponse.json({mission:await rpc('control_mission',{p_id:b.id,p_action:b.action,p_job:b.jobId??null})});
 }catch(error){return NextResponse.json({error:error instanceof z.ZodError?'Invalid mission request':error instanceof Error?error.message.slice(0,400):'Mission operation failed'},{status:409});}
}
