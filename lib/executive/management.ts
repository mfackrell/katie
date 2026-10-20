import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {handleExecutiveSpecialistIntake} from './intake';
import {startSpecialistAssignment} from './factory-runtime';
import {startExecutiveFinance,startExecutiveDevelopment} from './autonomous';
import {startGeneralExecutiveManagement} from './general';

/**
 * Executive-exclusive management plane. A missed capability is a durable blocker,
 * NEVER permission to hand the assignment to the ordinary chat model.
 */
export async function handleExecutiveManagement(input:{
 actorId:string;chatId:string;requestId:string;message:string;activeRepoId?:string|null;
}):Promise<string>{
 const db=getSupabaseAdminClient();
 const {data:identity,error:identityError}=await db.from('actors')
  .select('actor_kind').eq('id',input.actorId).maybeSingle<{actor_kind:string}>();
 if(identityError||identity?.actor_kind!=='executive')throw Error('Executive management requires the dedicated executive identity');
 const {data:chat,error:chatError}=await db.from('chats').select('actor_id').eq('id',input.chatId).maybeSingle<{actor_id:string}>();
 if(chatError||chat?.actor_id!==input.actorId)throw Error('Executive conversation ownership mismatch');
 const {data:prior,error:priorError}=await db.from('executive_management_requests')
  .select('objective,status,detail,plan').eq('actor_id',input.actorId).eq('chat_id',input.chatId)
  .eq('request_id',input.requestId).maybeSingle<{objective:string;status:string;detail:string|null;plan:Parameters<typeof startGeneralExecutiveManagement>[1]|null}>();
 if(priorError)throw Error('Executive management history unavailable');
 if(prior&&prior.objective!==input.message)throw Error('Executive request ID reused with a different objective');
 if(prior?.status!=='received'&&prior?.status!=='planning'&&prior?.detail)return prior.detail;
 if(!prior){
  const {error}=await db.from('executive_management_requests').insert({
   actor_id:input.actorId,chat_id:input.chatId,request_id:input.requestId,
   objective:input.message,status:'received'
  });
  if(error)throw Error('Executive objective could not be durably registered');
 }
 let result:string|null=null;
 // Existing management contracts can be reused, but only within Executive.
 if(prior?.plan)return startGeneralExecutiveManagement(input,prior.plan);
 result=await handleExecutiveSpecialistIntake(input);
 if(!result)result=await startSpecialistAssignment(input);
 if(!result)result=await startExecutiveFinance(input);
 if(!result)result=await startExecutiveDevelopment(input);
 if(!result)return startGeneralExecutiveManagement(input);
 const status=result&&(/\b(?:delegated|assigned|executing|launched)\b|\bMission:\s*[0-9a-f-]{36}/i.test(result))?'delegated':'blocked';
 if(!result){
  result='Executive assignment registered but BLOCKED: no authorized autonomous specialist workflow was selected for this objective. The Executive has NOT performed the assignment, created agents, or completed an audit. An executive planning/provisioning capability must be implemented and independently verified before this work can start. Ordinary Katie chat will not be used as a fallback.';
 }
 const {error:saveError}=await db.from('executive_management_requests')
  .eq('actor_id',input.actorId).eq('chat_id',input.chatId).eq('request_id',input.requestId)
  .update({status,detail:result,updated_at:new Date().toISOString()});
 if(saveError)throw Error('Executive management result could not be recorded');
 return result;
}
