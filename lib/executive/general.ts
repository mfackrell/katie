import {createHash} from 'node:crypto';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {saveMessage} from '@/lib/data/persistence-store';
import {executivePlanSchema,planExecutiveAssignment,type ExecutivePlan} from './planner';
import {startSpecialistAssignment,startSpecialistFactory} from './factory-runtime';

type Assignment=ExecutivePlan['assignments'][number]&{requestId:string;missionId?:string;sourceMissionIds?:string[];blocked?:string};
type Provision=ExecutivePlan['provision'][number]&{requestId:string;started?:boolean;blocked?:string};
type SavedPlan={assignments:Assignment[];provision:Provision[];unavailable:ExecutivePlan['unavailable'];createdAt:string};
type RecordRow={id:string;actor_id:string;chat_id:string;request_id:string;objective:string;status:string;detail:string|null;plan:SavedPlan|null};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function finalId(id:string){const h=hash('executive-project-final:'+id);return [h.slice(0,8),h.slice(8,12),'4'+h.slice(13,16),'8'+h.slice(17,20),h.slice(20,32)].join('-');}
function assignmentKey(id:string){return 'exec-specialist-task-'+hash(id).slice(0,40);}
const missionPattern=/\bMission:\s*([0-9a-f]{8}-[0-9a-f-]{27,})\b/i;
const supported=new Set(['financial_analysis','operations_analysis','research_synthesis']);
async function persist(row:Pick<RecordRow,'actor_id'|'chat_id'|'request_id'>,plan:SavedPlan,status:'planning'|'running'|'completed'|'blocked',detail:string){
 const {error}=await getSupabaseAdminClient().from('executive_management_requests')
  .eq('actor_id',row.actor_id).eq('chat_id',row.chat_id).eq('request_id',row.request_id)
  .update({plan,status,detail,updated_at:new Date().toISOString()});
 if(error)throw Error('Executive management plan could not be saved');
}
async function recoverMissionId(requestId:string){
 const {data,error}=await getSupabaseAdminClient().from('executive_delegations')
  .select('mission_id').eq('request_key',assignmentKey(requestId))
  .maybeSingle<{mission_id:string|null}>();
 if(error)throw Error('Executive mission evidence unavailable');
 return data?.mission_id??null;
}
async function sendAssignment(row:Pick<RecordRow,'actor_id'|'chat_id'>,assignment:Assignment,activeRepoId?:string|null){
 if(assignment.missionId||assignment.blocked)return;
 if(assignment.requiresRepository&&!activeRepoId){
  assignment.blocked='A verified connected repository must be selected for repository inspection; no code was accessed.';
  return;
 }
 const normalized=assignment.objective.replace(/\s+/g,' ');
 const message='Ask the '+assignment.slug.replaceAll('_',' ')+' orchestrator to '+normalized+(assignment.requiresRepository?' Inspect the connected repository read-only; do not modify it.':'');
 const reply=await startSpecialistAssignment({
  actorId:row.actor_id,chatId:row.chat_id,requestId:assignment.requestId,
  message,activeRepoId,sourceMissionIds:assignment.sourceMissionIds
 });
 const missionId=reply?.match(missionPattern)?.[1]??await recoverMissionId(assignment.requestId);
 if(missionId){assignment.missionId=missionId;return;}
 assignment.blocked=(reply??'Specialist mission could not start').slice(0,1200);
}
async function advanceProvision(row:Pick<RecordRow,'actor_id'|'chat_id'>,item:Provision){
 if(item.blocked)return;
 if(!supported.has(item.capability)){
  item.blocked='Requested capability is not in the verified specialist factory catalog';
  return;
 }
 const {data:registry,error}=await getSupabaseAdminClient().from('executive_orchestrators')
  .select('slug,status,capabilities').eq('actor_id',row.actor_id).eq('slug',item.domain)
  .maybeSingle<{slug:string;status:string;capabilities:string[]}>();
 if(error)throw Error('Executive provisioned specialist lookup failed');
 if(registry?.status==='active'&&registry.capabilities.includes(item.capability))return;
 if(item.started){
  const {data:request,error:requestError}=await getSupabaseAdminClient()
   .from('executive_provisioning_requests').select('status,evidence')
   .eq('actor_id',row.actor_id).eq('chat_id',row.chat_id)
   .eq('request_key','exec-factory-'+hash(item.requestId+'\n'+'Create a '+item.domain+' orchestrator').slice(0,40))
   .maybeSingle<{status:string;evidence:{reason?:string}|null}>();
  if(requestError)throw Error('Executive specialist commissioning state unavailable');
  if(request?.status==='blocked'||request?.status==='cancelled')
   item.blocked=request.evidence?.reason??'Independent specialist factory acceptance failed';
  return;
 }
 const response=await startSpecialistFactory({
  actorId:row.actor_id,chatId:row.chat_id,requestId:item.requestId,
  message:'Create a '+item.domain+' orchestrator',
  intent:{domain:item.domain,slug:item.domain,capability:item.capability}
 });
 if(/\b(?:pending|unavailable|blocked|cannot|could not|lacks)\b/i.test(response))
  item.blocked=response.slice(0,1000);
 else item.started=true;
}
async function specialistActive(row:Pick<RecordRow,'actor_id'>,item:Provision){
 const {data,error}=await getSupabaseAdminClient().from('executive_orchestrators')
  .select('status,capabilities').eq('actor_id',row.actor_id).eq('slug',item.domain)
  .maybeSingle<{status:string;capabilities:string[]}>();
 if(error)throw Error('Specialist activation status unavailable');
 return data?.status==='active'&&data.capabilities.includes(item.capability);
}
async function advancePlan(row:RecordRow,plan:SavedPlan,activeRepoId?:string|null){
 for(const work of plan.assignments){
  try{await sendAssignment(row,work,activeRepoId);}
  catch(error){work.blocked='Mission dispatch failed: '+(error instanceof Error?error.message.slice(0,500):'unknown');}
 }
 for(const provision of plan.provision){
  try{await advanceProvision(row,provision);}
  catch(error){provision.blocked='Commissioning failed: '+(error instanceof Error?error.message.slice(0,500):'unknown');}
  if(!provision.blocked&&await specialistActive(row,provision)){
   // Commissioned specialists receive their first real objective; commissioning
   // is NOT itself equivalent to delivery of the user's requested result.
   const existing=plan.assignments.find(x=>x.requestId===provision.requestId+'-assignment');
   if(!existing){
    // Newly commissioned specialists receive the completed source work, not
    // just instructions to synthesize reports they cannot otherwise access.
    const sourceDependent=provision.sourceSlugs!==undefined?provision.sourceSlugs.length>0:provision.capability==='research_synthesis'&&/\b(?:synthesi[sz]e|consolidat\w*|integrat\w*)\b/i.test(provision.objective)&&/\b(?:upstream|workstreams?|technical|operational|source reports?)\b/i.test(provision.objective);
    const original=sourceDependent?plan.assignments.filter(a=>!plan.provision.some(p=>a.requestId===p.requestId+'-assignment')&&(!provision.sourceSlugs||provision.sourceSlugs.includes(a.slug))):[];
    const sources=await Promise.all(original.map(a=>a.missionId?missionState(a.missionId):{state:a.blocked?'blocked':'running',result:''}));
    if(sources.some(s=>s.state==='running'))continue;
    if(sources.some(s=>s.state!=='verified')){provision.blocked='Source workstreams have not passed independent review; synthesis was not started.';continue;}
    plan.assignments.push({
     slug:provision.domain,objective:provision.objective,requiresRepository:false,
     requestId:provision.requestId+'-assignment',sourceMissionIds:original.flatMap(a=>a.missionId?[a.missionId]:[])
    });
   }
  }
 }
 for(const work of plan.assignments){
  try{await sendAssignment(row,work,activeRepoId);}
  catch(error){work.blocked='Mission dispatch failed: '+(error instanceof Error?error.message.slice(0,500):'unknown');}
 }
}
export async function startGeneralExecutiveManagement(input:{
 actorId:string;chatId:string;requestId:string;message:string;activeRepoId?:string|null;
},existingPlan?:SavedPlan|null){
 const db=getSupabaseAdminClient();
 let plan=existingPlan??null;
 if(!plan){
  const {data:inventory,error}=await db.from('executive_orchestrators')
   .select('slug,title,description,capabilities').eq('actor_id',input.actorId)
   .eq('status','active').limit(50)
   .returns<{slug:string;title:string;description:string;capabilities:string[]}>();
  if(error)throw Error('Executive specialist registry unavailable');
  const proposed=await planExecutiveAssignment({objective:input.message,specialists:inventory??[],requestId:input.requestId});
  const valid=executivePlanSchema.parse(proposed);
  plan={
   assignments:valid.assignments.map((value,i)=>({...value,requestId:input.requestId+'-a'+i})),
   provision:valid.provision.map((value,i)=>({...value,requestId:input.requestId+'-p'+i})),
   unavailable:valid.unavailable,createdAt:new Date().toISOString()
  };
  await persist({actor_id:input.actorId,chat_id:input.chatId,request_id:input.requestId},plan,'planning','Executive delegation plan saved.');
 }
 const row={id:'',actor_id:input.actorId,chat_id:input.chatId,request_id:input.requestId,objective:input.message,status:'planning',detail:null,plan};
 await advancePlan(row,plan,input.activeRepoId);
 const running=plan.assignments.filter(x=>x.missionId).length;
 const commissioning=plan.provision.filter(x=>x.started&&!x.blocked).length;
 const blockers=[...plan.assignments.flatMap(x=>x.blocked?[x.slug+': '+x.blocked]:[]),
  ...plan.provision.flatMap(x=>x.blocked?[x.domain+': '+x.blocked]:[]),
  ...plan.unavailable.map(x=>x.capability+': '+x.reason)];
 const state=running||commissioning?'running':'blocked';
 const receipt='Executive objective registered. Autonomous specialist missions started: '+running+
  '. Specialist commissioning workflows started: '+commissioning+
  '. Unavailable or blocked workstreams: '+blockers.length+'.'+
  (blockers.length?'\n\nBlocked scope:\n'+blockers.map(x=>'- '+x).join('\n'):'')+
  '\n\nThis is a management receipt, NOT a completed audit or specialist deliverable. Actual independently reviewed results will be delivered to this conversation.';
 await persist(row,plan,state,receipt);
 return receipt;
}
async function missionState(id:string){
 const db=getSupabaseAdminClient();
 const {data:mission,error}=await db.from('agent_missions').select('status,result,detail')
  .eq('id',id).maybeSingle<{status:string;result:string|null;detail:string|null}>();
 if(error||!mission)return{state:'running',result:''};
 if(!['completed','blocked','failed','stopped'].includes(mission.status))return{state:'running',result:''};
 const {data:reviews,error:reviewError}=await db.from('mission_assignments')
  .select('job_key,result,status').eq('mission_id',id).eq('role','review')
  .eq('status','completed').limit(20)
  .returns<{job_key:string;result:{verdict?:string}|null;status:string}>();
 if(reviewError)throw Error('Executive independent review evidence unavailable');
 const reviewed=reviews?.find(x=>x.job_key==='review_again')??reviews?.find(x=>x.job_key==='review');
 const approved=mission.status==='completed'&&reviewed?.result?.verdict==='pass'&&Boolean(mission.result?.trim());
 return approved?{state:'verified',result:mission.result??''}:{state:'blocked',result:mission.detail??'Independent specialist review did not pass'};
}
export async function reconcileExecutiveManagement(){
 const db=getSupabaseAdminClient();
 const {data:pending,error}=await db.from('executive_management_requests')
  .select('id,actor_id,chat_id,request_id,objective,status,detail,plan')
  .in('status',['planning','running']).order('updated_at',{ascending:true}).limit(30)
  .returns<RecordRow>();
 if(error)throw Error('Executive project inventory unavailable');
 let completed=0,blocked=0,working=0;
 for(const row of pending??[]){
  const plan=row.plan;
  if(!plan){working++;continue;}
  try{
   await advancePlan(row,plan); // Resumes factory activation and linked missions.
   const states=await Promise.all(plan.assignments.map(async a=>a.missionId?await missionState(a.missionId):{state:a.blocked?'blocked':'running',result:a.blocked??''}));
   const waiting=states.some(x=>x.state==='running')||plan.provision.some(p=>p.started&&!p.blocked&&!plan.assignments.some(a=>a.requestId===p.requestId+'-assignment'));
   if(waiting){await persist(row,plan,'running',row.detail??'Specialists are working');working++;continue;}
   const accepted=states.filter(x=>x.state==='verified');
   const failures=[...states.filter(x=>x.state==='blocked').map(x=>x.result),
    ...plan.provision.flatMap(x=>x.blocked?[x.domain+': '+x.blocked]:[]),
    ...plan.unavailable.map(x=>x.capability+': '+x.reason)];
   const report='EXECUTIVE DELIVERY — '+(failures.length?'PARTIAL / BLOCKED':'INDEPENDENTLY VERIFIED')+
    '\n\nOriginal objective:\n'+row.objective.slice(0,1500)+
    '\n\nSpecialist results:\n'+states.map((state,i)=>'## '+plan.assignments[i].slug+' — '+state.state+'\n'+state.result).join('\n\n')+
    (failures.length?'\n\nUnresolved limitations:\n'+failures.map(x=>'- '+x.slice(0,700)).join('\n'):'')+
    '\n\nThe Executive did not perform these specialist analyses; only saved, reviewed specialist results are represented as verified.';
   const id=finalId(row.id+'\n'+report);
   const {data:priorMessage,error:priorError}=await db.from('messages').select('id').eq('id',id).maybeSingle();
   if(priorError)throw Error('Executive final delivery receipt unavailable');
   if(!priorMessage)await saveMessage(row.chat_id,{id,role:'assistant',content:report});
   const state=failures.length||!accepted.length?'blocked':'completed';
   await persist(row,plan,state,report);
   if(state==='completed')completed++;else blocked++;
  }catch(error){
   console.error('[Executive] Manager reconciliation deferred',{requestId:row.request_id,reason:error instanceof Error?error.message:'unknown'});
   working++;
  }
 }
 return{completed,blocked,working};
}
