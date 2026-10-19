import {NextResponse} from 'next/server';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {listChats,listActors} from '@/lib/data/persistence-store';

// Recovery dashboard is read-only. Approval and GitHub authorization live in
// their existing server-side workflows, never in an untrusted browser request.
export async function GET(){
 try{
  const chats=await listChats();
  const actors=await listActors();
  const allowed=new Set(actors.map(a=>a.id));
  const ownedChats=new Map(chats.filter(c=>allowed.has(c.actorId)).map(c=>[c.id,c.actorId]));
  const {data,error}=await getSupabaseAdminClient().from('recovery_cases')
   .select('id,source_type,source_id,actor_id,chat_id,status,category,strategy,attempt,details,repair_issue_url,repair_pr_url,updated_at')
   .order('updated_at',{ascending:false}).limit(100);
  if(error)throw Error('Recovery history unavailable');
  const cases=((data??[]) as Array<{id:string;source_type:string;source_id:string;actor_id:string;chat_id:string|null;status:string;category:string|null;strategy:string|null;attempt:number;details:string;repair_issue_url:string|null;repair_pr_url:string|null;updated_at:string}>).filter(c=>allowed.has(c.actor_id)&&(!c.chat_id||ownedChats.get(c.chat_id)===c.actor_id))
    .map(c=>({id:c.id,sourceType:c.source_type,sourceId:c.source_id,actorId:c.actor_id,
      chatId:c.chat_id,status:c.status,category:c.category,strategy:c.strategy,attempt:c.attempt,
      details:c.details,issueUrl:c.repair_issue_url,prUrl:c.repair_pr_url,updatedAt:c.updated_at}));
  return NextResponse.json({cases},{headers:{'Cache-Control':'no-store'}});
 }catch(error){
  console.error('[Recovery] Owner overview failed',error instanceof Error?error.message:'Unknown error');
  return NextResponse.json({error:'Recovery dashboard unavailable'},{status:503,headers:{'Cache-Control':'no-store'}});
 }
}
