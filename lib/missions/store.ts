import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import type { Assignment,Mission } from './types';
// Timings are emitted without arguments, credentials, actor IDs, or query contents.
// RPC duration includes pool acquisition, advisory lock waits, and execution;
// it is not itself a measurement of advisory lock hold time.
export async function rpc<T>(name:string,args:Record<string,unknown>={}):Promise<T>{
 const started=performance.now();
 try{
  const {data,error}=await getSupabaseAdminClient().rpc<T>(name,args);
  if(error)throw Error('Mission state operation failed: '+error.message.slice(0,350));
  return data;
 }finally{
  const elapsedMs=Math.round(performance.now()-started);
  if(elapsedMs>=1000)console.warn('[Mission RPC latency]',{
   operation:name,elapsedMs,thresholdMs:1000,
   interpretation:'End-to-end RPC latency; investigate DB lock waits separately'
  });
 }
}
export async function readMission(id:string){
 const db=getSupabaseAdminClient();
 const {data:mission,error}=await db.from('agent_missions').select('*').eq('id',id).maybeSingle<Mission>();
 if(error||!mission)throw Error('Mission unavailable');
 const {data:jobs,error:jobError}=await db.from('mission_assignments').select('*').eq('mission_id',id).order('created_at',{ascending:true});
 if(jobError)throw Error('Assignment history unavailable');
 return {mission,jobs:(jobs??[]) as Assignment[]};
}
