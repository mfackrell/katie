import {createHash} from 'node:crypto';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';

function uuid(value:string){
 const h=createHash('sha256').update(value).digest('hex');
 return [h.slice(0,8),h.slice(8,12),'4'+h.slice(13,16),'8'+h.slice(17,20),h.slice(20,32)].join('-');
}
// Preserve the existing durable message IDs used by both reconcilers.
export const delegationReplyId=(id:string,succeeded=false)=>uuid('executive-finance-mission:executive-reply-'+id+(succeeded?':completed':''));
export const factoryReplyId=(id:string,succeeded=false)=>uuid('executive-factory:reply:'+id+(succeeded?':activated':''));
type Delegation={id:string;status:string;request_key:string;mission_id:string|null};
type Provisioning={id:string;status:string;route:string;evidence:{acceptanceMissionId?:string;acceptanceEvidence?:Array<{missionId?:string}>}|null};
export function executiveDeliveryPending(delegations:Delegation[],provisioning:Provisioning[],messageIds:Set<string>,legacySuccessIds=new Set<string>()){
 const assignment=delegations.some(d=>d.mission_id&&
  /^(exec-finance-|exec-dev-|exec-specialist-task-)/.test(d.request_key)&&
  (['proposed','accepted','running','submitted'].includes(d.status)||
   ['verified','cancelled'].includes(d.status)&&!messageIds.has(delegationReplyId(d.id,d.status==='verified'))&&
    !(d.status==='verified'&&legacySuccessIds.has(delegationReplyId(d.id)))));
 const factory=provisioning.some(p=>p.route==='configure'&&
  Boolean(p.evidence?.acceptanceMissionId||p.evidence?.acceptanceEvidence?.some(e=>e.missionId))&&
  (['configured','validated'].includes(p.status)||
   ['activated','blocked'].includes(p.status)&&
    !messageIds.has(factoryReplyId(p.id,p.status==='activated'))&&
    !(p.status==='activated'&&legacySuccessIds.has(factoryReplyId(p.id)))));
 return assignment||factory;
}
export async function hasPendingExecutiveDelivery(actorId:string,chatId:string,messages:Array<{id:string;content?:unknown}>){
 const db=getSupabaseAdminClient();
 const ids=new Set(messages.map(m=>m.id));
 const legacySuccessIds=new Set(messages.filter(m=>typeof m.content==='string'&&/^(?:(?:Development|Specialist|Finance) completed and passed independent review\.|Executive activated )/.test(m.content)).map(m=>m.id));
 async function inventory(table:string,fields:string,pending:(rows:unknown[])=>boolean){
  // A full first page cannot establish that older work has finished. Stable,
  // oldest-first pages also avoid insertion shifting records across offsets.
  for(let offset=0;;offset+=100){
   const {data,error}=await db.from(table).select(fields).eq('actor_id',actorId).eq('chat_id',chatId)
    .order('created_at',{ascending:true}).order('id',{ascending:true}).range(offset,offset+99);
   if(error)throw Error('Executive delivery status unavailable');
   const rows=data??[];
   if(pending(rows))return true;
   if(rows.length<100)return false;
  }
 }
 const pending=await Promise.all([
  inventory('executive_delegations','id,status,request_key,mission_id',rows=>executiveDeliveryPending(rows as Delegation[],[],ids,legacySuccessIds)),
  inventory('executive_provisioning_requests','id,status,route,evidence',rows=>executiveDeliveryPending([],rows as Provisioning[],ids,legacySuccessIds)),
 ]);
 return pending.some(Boolean);
}
