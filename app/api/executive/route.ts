import {NextResponse} from 'next/server';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {listActors,listChats} from '@/lib/data/persistence-store';
export async function GET(){
 try{
  const [actors,chats]=await Promise.all([listActors(),listChats()]);
  const actorIds=new Set(actors.map(a=>a.id)),ownedChats=new Map(chats.map(c=>[c.id,c.actorId]));
  const db=getSupabaseAdminClient();
  const [registry,delegations]=await Promise.all([
   db.from('executive_orchestrators').select('*').order('created_at',{ascending:false}).limit(100),
   db.from('executive_delegations').select('*').order('created_at',{ascending:false}).limit(100)
  ]);
  if(registry.error||delegations.error)throw Error('Executive registry not available');
  const specialists=(registry.data??[]) as Array<{actor_id:string}>;
  const assigned=(delegations.data??[]) as Array<{actor_id:string;chat_id:string}>;
  return NextResponse.json({
   specialists:specialists.filter(x=>actorIds.has(x.actor_id)),
   delegations:assigned.filter(x=>actorIds.has(x.actor_id)&&ownedChats.get(x.chat_id)===x.actor_id)
  },{headers:{'Cache-Control':'no-store'}});
 }catch(error){
  console.error('[Executive] Registry overview error',error instanceof Error?error.message:'Unknown');
  return NextResponse.json({error:'Executive registry unavailable'},{status:503});
 }
}