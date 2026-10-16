import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import type { Assignment,Mission } from './types';
export async function rpc<T>(name:string,args:Record<string,unknown>={}):Promise<T>{const {data,error}=await getSupabaseAdminClient().rpc<T>(name,args);if(error)throw Error('Mission state operation failed: '+error.message.slice(0,350));return data;}
export async function readMission(id:string){
 const db=getSupabaseAdminClient();
 const {data:mission,error}=await db.from('agent_missions').select('*').eq('id',id).maybeSingle<Mission>();
 if(error||!mission)throw Error('Mission unavailable');
 const {data:jobs,error:jobError}=await db.from('mission_assignments').select('*').eq('mission_id',id).order('created_at',{ascending:true});
 if(jobError)throw Error('Assignment history unavailable');
 return {mission,jobs:(jobs??[]) as Assignment[]};
}
