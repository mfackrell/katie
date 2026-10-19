import {createHash} from 'node:crypto';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {saveMessage} from '@/lib/data/persistence-store';

// Only explicit, standalone financial-analysis objectives enter the pilot.
// Registry capabilities are authoritative; never route software or external writes.
export function financeDelegationIntent(message:string){
 const text=message.trim();
 if(text.length<35||text.length>7000)return false;
 if(!/^(?:please\s+)?(?:analy[sz]e|assess|evaluate|review|prepare\s+(?:a\s+)?(?:financial|cfo)|provide\s+(?:a\s+)?(?:financial|cfo))\b/i.test(text))return false;
 if(!/\b(?:financial|finance|revenue|gross margin|operating margin|profitability|cash flow|income statement|balance sheet|quarterly performance)\b/i.test(text))return false;
 if(/\b(?:create|build|modify|deploy|merge|delete|publish|send|email|purchase|transfer|pay|post|update records|change the database)\b/i.test(text))return false;
 return true;
}
function missionId(key:string){
 const hex=createHash('sha256').update('executive-finance-mission:'+key).digest('hex');
 return [hex.slice(0,8),hex.slice(8,12),'4'+hex.slice(13,16),'8'+hex.slice(17,20),hex.slice(20,32)].join('-');
}
export async function startExecutiveFinance(input:{actorId:string;chatId:string;message:string;requestId:string}):Promise<string|null>{
 if(!financeDelegationIntent(input.message))return null;
 const db=getSupabaseAdminClient(),requestKey='exec-finance-'+createHash('sha256').update(input.requestId).digest('hex').slice(0,40);
 const {data:existing,error:existingError}=await db.from('executive_delegations').select('id,mission_id,status').eq('actor_id',input.actorId).eq('chat_id',input.chatId).eq('request_key',requestKey).maybeSingle();
 if(existingError)throw Error('Executive request history unavailable');
 if(existing){const row=existing as {id:string;status:string};return 'Finance assignment already recorded. Delegation '+row.id+'; status '+row.status+'.';}
 const {data:matches,error:registryError}=await db.from('executive_orchestrators').select('slug,id').eq('actor_id',input.actorId).eq('status','active').contains('capabilities',['financial_analysis']).order('slug').limit(1);
 if(registryError)throw Error('Executive specialist registry unavailable');
 const finance=(matches as Array<{id:string;slug:string}>|null)?.[0];
 if(!finance)return null; // Ordinary Katie remains responsible if no verified specialist exists.
 const {data:agents,error:agentError}=await db.from('managed_agents').select('id,config').eq('archived',false).limit(100);
 if(agentError)throw Error('Executive worker inventory unavailable');
 const team=agents as Array<{id:string;config:{name?:string}}>|null;
 const leader=team?.find(a=>a.config?.name==='Mission Lead');
 const analyst=team?.find(a=>a.config?.name==='Analysis Agent');
 if(!leader||!analyst)throw Error('Verified finance mission workers unavailable');
 const deadline=new Date(Date.now()+40*60000).toISOString(),id=missionId(requestKey);
 const success=['Calculate accurately using only supplied evidence','Give actionable CFO analysis and label assumptions','Pass independent saved mission review'];
 const {data:delegation,error:delegationError}=await db.rpc('propose_executive_delegation',{
  p_actor:input.actorId,p_chat:input.chatId,p_slug:finance.slug,p_request:requestKey,
  p_objective:input.message,p_capability:'financial_analysis',p_success:success,p_budget:60000,p_deadline:deadline
 });
 const delegationRow=delegation as {id:string}|null;
 if(delegationError||!delegationRow?.id)throw Error('Executive delegation creation failed');
 const {error:missionError}=await db.rpc('create_mission',{p_id:id,p_objective:input.message,p_agents:[leader.id,analyst.id],p_minutes:30,p_repository:null});
 if(missionError)throw Error('Finance mission creation failed: '+missionError.message.slice(0,150));
 const {error:linkError}=await db.from('executive_delegations').update({mission_id:id}).eq('id',delegationRow.id).eq('status','proposed');
 if(linkError)throw Error('Finance mission linkage failed');
 const {error:startError}=await db.rpc('control_mission',{p_id:id,p_action:'start',p_job:null});
 if(startError)throw Error('Finance mission start failed');
 for(const action of ['accept','start']){
  const {data,error}=await db.rpc('transition_executive_delegation',{p_id:delegationRow.id,p_actor:input.actorId,p_chat:input.chatId,p_action:action,p_evidence:{}});
  if(error||!data)throw Error('Executive delegation transition failed: '+action);
 }
 return 'I delegated this financial analysis to Finance. Katie is executing it through the saved mission worker with independent review. I will post the reviewed result in this conversation when finished. Delegation: '+delegationRow.id+'.';
}

export async function reconcileExecutiveFinance(){
 const db=getSupabaseAdminClient();
 const {data:running,error}=await db.from('executive_delegations') .select('id,actor_id,chat_id,mission_id,status').like('request_key','exec-finance-%').in('status',['running','verified','cancelled']).not('mission_id','is',null).order('updated_at',{ascending:false}).limit(100);
 if(error)throw Error('Executive reconciliation inventory unavailable');
 let verified=0,blocked=0;
 for(const d of (running??[]) as Array<{id:string;actor_id:string;chat_id:string;mission_id:string;status:string}>){
  const {data:mission,error:missionError}=await db.from('agent_missions').select('status,result,detail').eq('id',d.mission_id).maybeSingle();
  const missionRow=mission as {status:string;result:string|null;detail:string|null}|null;
  if(missionError||!missionRow||!['completed','blocked','failed','stopped'].includes(missionRow.status))continue;
  const {data:review}=await db.from('mission_assignments').select('result,status').eq('mission_id',d.mission_id).eq('role','review').eq('status','completed').limit(1);
  const reviewPassed=(review as Array<{result:{verdict?:string}|null}>|null)?.some(r=>r.result?.verdict==='pass');
  const succeeded=missionRow.status==='completed'&&reviewPassed&&typeof missionRow.result==='string'&&missionRow.result.length>0;
  if(d.status==='running'&&succeeded){
   const {data:submitted,error:submitError}=await db.rpc('transition_executive_delegation',{p_id:d.id,p_actor:d.actor_id,p_chat:d.chat_id,p_action:'submit',p_evidence:{deliverable:missionRow.result.slice(0,16000),missionId:d.mission_id,independentReview:'mission-pass'}});
   if(submitError||submitted?.status!=='submitted')continue;
   const {data:accepted,error:acceptError}=await db.rpc('transition_executive_delegation',{p_id:d.id,p_actor:d.actor_id,p_chat:d.chat_id,p_action:'verify',p_evidence:{independentReview:'pass',missionId:d.mission_id}});
   if(acceptError||accepted?.status!=='verified')continue;
   verified++;
  }else if(d.status==='running'){
   // An incomplete or unreviewed mission can never be accepted.
   const {data:cancelled,error:cancelError}=await db.rpc('transition_executive_delegation',{p_id:d.id,p_actor:d.actor_id,p_chat:d.chat_id,p_action:'cancel',p_evidence:{reason:'Mission did not pass independent review',missionId:d.mission_id}});
   if(cancelError||cancelled?.status!=='cancelled')continue;
   blocked++;
  }
  // Persist output after recording the transition, using a stable ID so cron
  // retries cannot generate duplicate final chat messages.
  const output=succeeded?'Finance completed and passed independent review.\n\n'+missionRow.result:'Finance could not complete this assignment. '+(missionRow.detail??'Independent acceptance was not established.');
  try{
   const replyId=missionId('executive-reply-'+d.id);
   const {data:existingReply,error:messageLookupError}=await db.from('messages').select('id').eq('id',replyId).maybeSingle();
   if(messageLookupError)throw messageLookupError;
   if(!existingReply)await saveMessage(d.chat_id,{id:replyId,role:'assistant',content:output});
  }catch(e){console.error('[Executive] Chat handoff failed',{delegationId:d.id,error:e instanceof Error?e.message:'unknown'});}
 }
 return {verified,blocked};
}
