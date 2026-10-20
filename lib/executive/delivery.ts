import {createHash} from 'node:crypto';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';

function uuid(value:string){
 const h=createHash('sha256').update(value).digest('hex');
 return [h.slice(0,8),h.slice(8,12),'4'+h.slice(13,16),'8'+h.slice(17,20),h.slice(20,32)].join('-');
}
// Preserve the existing durable message IDs used by both reconcilers.
export const delegationReplyId=(id:string)=>uuid('executive-finance-mission:executive-reply-'+id);
export const factoryReplyId=(id:string)=>uuid('executive-factory:reply:'+id);
type Delegation={id:string;status:string;request_key:string;mission_id:string|null};
type Provisioning={id:string;status:string;route:string;evidence:{acceptanceMissionId?:string;acceptanceEvidence?:unknown[]}|null};
export function executiveDeliveryPending(delegations:Delegation[],provisioning:Provisioning[],messageIds:Set<string>){
 const assignment=delegations.some(d=>d.mission_id&&
  /^(exec-finance-|exec-dev-|exec-specialist-task-)/.test(d.request_key)&&
  (['proposed','accepted','running','submitted'].includes(d.status)||
   ['verified','cancelled'].includes(d.status)&&!messageIds.has(delegationReplyId(d.id))));
 const factory=provisioning.some(p=>p.route==='configure'&&
  (['configured','validated'].includes(p.status)||
   ['activated','blocked'].includes(p.status)&&
    Boolean(p.evidence?.acceptanceMissionId||p.evidence?.acceptanceEvidence?.length)&&
    !messageIds.has(factoryReplyId(p.id))));
 return assignment||factory;
}
export async function hasPendingExecutiveDelivery(actorId:string,chatId:string,messages:Array<{id:string}>){
 const db=getSupabaseAdminClient();
 const [delegations,provisioning]=await Promise.all([
  db.from('executive_delegations').select('id,status,request_key,mission_id')
   .eq('actor_id',actorId).eq('chat_id',chatId).order('created_at',{ascending:false}).limit(100),
  db.from('executive_provisioning_requests').select('id,status,route,evidence')
   .eq('actor_id',actorId).eq('chat_id',chatId).order('created_at',{ascending:false}).limit(100),
 ]);
 if(delegations.error||provisioning.error)throw Error('Executive delivery status unavailable');
 return executiveDeliveryPending((delegations.data??[]) as Delegation[],
  (provisioning.data??[]) as Provisioning[],new Set(messages.map(m=>m.id)));
}
