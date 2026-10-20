import {createHash} from 'node:crypto';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {saveMessage} from '@/lib/data/persistence-store';
import {planExecutiveProvisioning} from './provisioning-service';

type Intent={domain:string;slug:string;capability:string};
type Agent={id:string;config:{name?:string;research?:boolean;development?:boolean}};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function stableUuid(key:string){const h=digest('executive-factory:'+key);return [h.slice(0,8),h.slice(8,12),'4'+h.slice(13,16),'8'+h.slice(17,20),h.slice(20,32)].join('-');}
function stableKey(prefix:string,value:string){return prefix+digest(value).slice(0,40);}
function boundedError(error:unknown){return error instanceof Error?error.message.slice(0,220):'Unknown error';}
async function team(withDevelopment=false){
 const db=getSupabaseAdminClient();
 const {data,error}=await db.from('managed_agents').select('id,config').eq('archived',false).limit(100).returns<Agent>();
 if(error)throw Error('Saved specialist agents are unavailable');
 const agents=data??[];
 const lead=agents.find(a=>a.config.name==='Mission Lead');
 const analyst=agents.find(a=>a.config.name==='Analysis Agent')??agents.find(a=>a.config.name==='Project Lead');
 const specialist=withDevelopment
  ? agents.find(a=>a.config.name==='Development Agent'&&a.config.development)
  : agents.find(a=>a.config.name==='Research Agent'&&a.config.research)??agents.find(a=>a.config.name==='Project Research'&&a.config.research);
 if(!lead||!analyst||!specialist)throw Error('A verified lead, analyst, and specialist agent must be available');
 return [lead.id,analyst.id,specialist.id];
}
async function reportOnce(chatId:string,key:string,message:string){
 const db=getSupabaseAdminClient(),id=stableUuid('reply:'+key);
 const {data,error}=await db.from('messages').select('id').eq('id',id).maybeSingle<{id:string}>();
 if(error)throw Error('Executive delivery history unavailable');
 if(!data)await saveMessage(chatId,{id,role:'assistant',content:message});
}
/** Reuse the independently reviewed mission adapter. A domain label alone grants no new tools. */
export async function startSpecialistFactory(input:{actorId:string;chatId:string;requestId:string;message:string;intent:Intent}){
 const {actorId,chatId,requestId,intent}=input,db=getSupabaseAdminClient();
 const key=stableKey('exec-factory-',requestId+'\n'+input.message);
 const requirement={
  capability:intent.capability,
  objective:'Configure and independently accept a working '+intent.domain+' mission specialist.',
  successCriteria:['Three saved independent agents complete a real delegated mission','Final independent mission review passes','The specialist can receive new work through Executive'],
  proposedSlug:intent.slug,
  proposedTitle:intent.domain.replace(/\b[a-z]/g,c=>c.toUpperCase())+' Orchestrator',
  proposedDescription:'Executive-directed '+intent.domain+' specialist using the verified multi-agent mission runtime.',
  proposedCapabilities:[intent.capability],
 };
 // Capability selection must use the verified active mission catalog. A generic
 // research playbook does not prove a newly requested tool or specialty exists.
 const {decision,request}=await planExecutiveProvisioning({actorId,chatId,requestKey:key,requirement});
 if(decision.route==='reuse')return decision.specialistSlug+' is already an active specialist for '+intent.capability+'. You can assign it work directly.';
 if(decision.route==='commission')return 'Executive recorded the request for '+requirement.proposedTitle+
  ', but the verified mission capability catalog lacks '+decision.missingCapabilities.join(', ')+
  '. Specialist commissioning is pending; no unimplemented capability was configured or activated. Request: '+request.id+'.';
 if(request.status==='proposed'){
  const {data:configured,error}=await db.rpc('transition_executive_provisioning',{
   p_id:request.id,p_actor:actorId,p_chat:chatId,p_action:'configure',
   p_evidence:{capabilityCatalogVerified:true,adapter:'existing-reviewed-mission-runtime',toolsAdded:[]}
  });
  if(error||!configured)throw Error('Existing mission runtime configuration failed');
 }
 // The acceptance test is a real mission: not an activation assertion or a code generation promise.
 const agentIds=await team();
 const missionId=stableUuid('accept:'+key);
 const cases:Record<string,string>={
  financial_analysis:'Hypothetical business: revenue $10,000, cost of sales $6,000, operating expenses $2,500, cash $2,000 and accounts payable due this month $1,800. Have an analysis worker use the deterministic calculator for gross margin, operating profit and cash-versus-payables coverage; have a second saved worker separately challenge the assumptions and recommend an action.',
  operations_analysis:'Hypothetical service desk: 20 requests daily, 30-request daily capacity, 4 reopened requests per 100 completed, and a one-day turnaround goal. Have an analysis worker use the deterministic calculator for spare capacity and reopen rate; have a second saved worker identify quality risks and propose an action.',
  research_synthesis:'Using native LIVE public-web search, have a research-enabled saved worker find and cite at least one primary official source on small-business financial recordkeeping guidance (for example the IRS or SBA). Have a second saved worker independently assess relevance, distinguish the guidance from hypothetical advice, and describe one concrete takeaway. Never fabricate a URL or replace real search with model memory.',
 };
 const scenario=cases[intent.capability];
 if(!scenario)throw Error('No independently verifiable mission acceptance scenario supports this capability');
 const objective='SPECIALIST FACTORY ACCEPTANCE — '+requirement.proposedTitle+'. '+
  'Prove the declared '+intent.capability+' capability on this bounded case: '+scenario+
  ' Have the saved lead plan work for at least TWO distinct substantive workers, then compose a memo under 450 words with explicit assumptions, calculations or source links, separate worker findings and measurable acceptance criteria. Final independent review must pass. '+
  'Do not claim external integrations, repository access or specialist tools not provided by the existing mission adapter.';
 const {error:createError}=await db.rpc('create_mission',{
  p_id:missionId,p_objective:objective,p_agents:agentIds,p_minutes:110,p_repository:null
 });
 if(createError)throw Error('Specialist acceptance mission unavailable: '+boundedError(createError));
 // The independently reviewed multi-worker + possible revision cycle can
 // legitimately exceed the ordinary 60k-token mission allowance.
 const {error:budgetError}=await db.from('agent_missions').eq('id',missionId).eq('status','draft')
  .update({token_allowance:95000});
 if(budgetError)throw Error('Bounded specialist acceptance budget unavailable');
 const {error:saveError}=await db.from('executive_provisioning_requests').eq('id',request.id).eq('status','configured').update({
  evidence:{adapter:'mission',acceptanceMissionId:missionId,acceptanceCapability:intent.capability,teamIds:agentIds,capabilityCatalogVerified:true,toolsAdded:[]}
 });
 if(saveError)throw Error('Specialist factory acceptance linkage failed');
 const {error:startError}=await db.rpc('control_mission',{p_id:missionId,p_action:'start',p_job:null});
 if(startError)throw Error('Specialist acceptance could not start');
 return 'Executive has configured '+requirement.proposedTitle+' and launched its independent multi-agent acceptance mission. '+
  'It will be activated only if that real mission passes final independent review. Mission: '+missionId+'.';
}

export function specialistAssignmentIntent(message:string){
 const match=/^(?:please\s+)?(?:ask|have|tell|delegate to)\s+(?:the\s+)?([a-z][a-z -]{1,55}?)\s+(?:specialist\s+)?(?:orchestrator|sub-orchestrator)\s+(?:to\s+)?(.{12,})$/i.exec(message.trim());
 if(!match)return null;
 const slug=match[1].trim().toLowerCase().replace(/[^a-z0-9]+/g,'_');
 const objective=match[2].trim();
 if(!/^[a-z][a-z0-9_]{1,39}$/.test(slug)||objective.length<12)return null;
 return{slug,objective};
}
export async function startSpecialistAssignment(input:{actorId:string;chatId:string;requestId:string;message:string;activeRepoId?:string|null}):Promise<string|null>{
 const intent=specialistAssignmentIntent(input.message);if(!intent)return null;
 const db=getSupabaseAdminClient();
 const {data:registered,error}=await db.from('executive_orchestrators').select('slug,status,capabilities')
  .eq('actor_id',input.actorId).eq('slug',intent.slug).maybeSingle<{slug:string;status:string;capabilities:string[]}>();
 if(error)throw Error('Specialist assignment lookup unavailable');
 if(!registered||registered.status!=='active')return intent.slug+' is not active. Create and verify that orchestrator first.';
 const requestKey=stableKey('exec-specialist-task-',input.requestId);
 const {data:existing}=await db.from('executive_delegations').select('id,status').eq('actor_id',input.actorId).eq('chat_id',input.chatId).eq('request_key',requestKey).maybeSingle<{id:string;status:string}>();
 if(existing)return 'Specialist assignment '+existing.id+' is already '+existing.status+'.';
 const coding=/\b(?:implement|code|develop|fix the code|modify repository|deploy|build an app|build a website)\b/i.test(intent.objective);
 if(coding&&!input.activeRepoId)return 'Select a connected repository to authorize this coding assignment.';
 const agents=await team(coding);
 const missionId=stableUuid(requestKey),deadline=new Date(Date.now()+3*60*60000).toISOString();
 const {data:delegation,error:proposalError}=await db.rpc<{id:string}>('propose_executive_delegation',{
  p_actor:input.actorId,p_chat:input.chatId,p_slug:intent.slug,p_request:requestKey,
  p_objective:intent.objective,p_capability:registered.capabilities[0],
  p_success:['Deliver the requested result','Use independent agents and a final independent review','Report verified evidence or a blocker'],
  p_budget:60000,p_deadline:deadline
 });
 if(proposalError||!delegation?.id)throw Error('Specialist delegation failed');
 const {error:missionError}=await db.rpc('create_mission',{
  p_id:missionId,p_objective:intent.objective+'\nSpecialist: '+intent.slug+'; independently delegated worker tasks and final reviewed deliverable required.',
  p_agents:agents,p_minutes:110,p_repository:coding?input.activeRepoId:null
 });
 if(missionError)throw Error('Specialist mission creation failed: '+boundedError(missionError));
 const {error:linkError}=await db.from('executive_delegations').eq('id',delegation.id).eq('status','proposed').update({mission_id:missionId});
 if(linkError)throw Error('Specialist mission linking failed');
 const {error:startError}=await db.rpc('control_mission',{p_id:missionId,p_action:'start',p_job:null});
 if(startError)throw Error('Specialist mission failed to start');
 for(const action of ['accept','start']){
  const {data,error:transitionError}=await db.rpc('transition_executive_delegation',{p_id:delegation.id,p_actor:input.actorId,p_chat:input.chatId,p_action:action,p_evidence:{}});
  if(transitionError||!data)throw Error('Specialist delegation transition failed');
 }
 return 'Executive assigned '+intent.slug+' to its independent agent team. Verified results or blockers will appear in this conversation. Mission: '+missionId+'.';
}

export async function reconcileSpecialistFactory(){
 const db=getSupabaseAdminClient();
 const {data,error}=await db.from('executive_provisioning_requests')
  .select('id,actor_id,chat_id,specialist_slug,capability,status,evidence,updated_at')
  .eq('status','configured').order('updated_at',{ascending:false}).limit(100);
 if(error)throw Error('Specialist acceptance inventory unavailable');
 let activated=0,blocked=0;
 for(const request of (data??[]) as Array<{id:string;actor_id:string;chat_id:string;specialist_slug:string;capability:string;status:string;evidence:{acceptanceMissionId?:string}|null}>){
  const missionId=request.evidence?.acceptanceMissionId;
  if(!missionId)continue;
  const {data:mission,error:missionError}=await db.from('agent_missions')
   .select('status,result,detail').eq('id',missionId).maybeSingle<{status:string;result:string|null;detail:string|null}>();
  if(missionError||!mission||!['completed','blocked','stopped'].includes(mission.status))continue;
  const {data:reviews,error:reviewsError}=await db.from('mission_assignments')
   .select('job_key,status,result').eq('mission_id',missionId).eq('role','review')
   .eq('status','completed').limit(10).returns<{job_key:string;result:{verdict?:string}|null}>();
  if(reviewsError)throw Error('Independent factory review lookup failed');
  const final=reviews?.find(r=>r.job_key==='review_again')??reviews?.find(r=>r.job_key==='review');
  const {data:assignments,error:assignmentsError}=await db.from('mission_assignments')
   .select('agent_id,role,status,payload,result').eq('mission_id',missionId).eq('status','completed').limit(12)
   .returns<{agent_id:string;role:string;status:string;payload:{capability?:string}|null;result:{sources?:Array<{url?:string}>;calculations?:unknown[]}|null}>();
  if(assignmentsError)throw Error('Factory independent worker evidence unavailable');
  const workerIds=new Set((assignments??[]).filter(a=>a.role==='work'||a.role==='development').map(a=>a.agent_id));
  const workers=(assignments??[]).filter(a=>a.role==='work');
  // A generic memo cannot verify a declared domain capability. Require native
  // tool receipts from a worker, as well as the independent result review.
  const demonstrated=request.capability==='research_synthesis'
   ? workers.some(a=>a.payload?.capability==='research'&&a.result?.sources?.some(s=>typeof s.url==='string'&&/^https?:\/\//.test(s.url)))
   : ['financial_analysis','operations_analysis'].includes(request.capability)&&
    workers.some(a=>a.payload?.capability==='analysis'&&Boolean(a.result?.calculations?.length));
  const passed=mission.status==='completed'&&final?.result?.verdict==='pass'&&Boolean(mission.result?.trim())&&workerIds.size>=2&&demonstrated;
  if(passed){
   const evidence={independentReview:'pass',acceptanceEvidence:[{kind:'mission',missionId,capability:request.capability,verifiedToolEvidence:true,result:(mission.result??'').slice(0,3500)}]};
   const {data:validated,error:validationError}=await db.rpc('transition_executive_provisioning',{
    p_id:request.id,p_actor:request.actor_id,p_chat:request.chat_id,p_action:'validate',p_evidence:evidence
   });
   if(validationError||!validated)continue;
   const {data:active,error:activationError}=await db.rpc('transition_executive_provisioning',{
    p_id:request.id,p_actor:request.actor_id,p_chat:request.chat_id,p_action:'activate',p_evidence:{independentReview:'pass'}
   });
   if(activationError||!active)continue;
   const {error:upgradeError}=await db.from('executive_orchestrators').eq('actor_id',request.actor_id)
    .eq('slug',request.specialist_slug).eq('status','active').update({autonomy:'delegated'});
   if(upgradeError)throw Error('Specialist autonomous operation configuration failed');
   await reportOnce(request.chat_id,request.id,'Executive activated '+request.specialist_slug+
    ' after a completed, independently reviewed three-agent acceptance mission. You can assign it objectives directly. Mission '+missionId+'.');
   activated++;
  }else{
   const reason=!demonstrated?'The declared capability was not proven with a native calculator or live-web research receipt':
    mission.detail??'Independent acceptance failed';
   const {error:blockError}=await db.from('executive_provisioning_requests').eq('id',request.id).eq('status','configured')
    .update({status:'blocked',evidence:{acceptanceMissionId:missionId,reason}});
   if(blockError)throw Error('Specialist factory blocker could not be saved');
   await reportOnce(request.chat_id,request.id,'Executive could not activate '+request.specialist_slug+
    ': '+reason+'. Mission '+missionId+'.');
   blocked++;
  }
 }
 return{activated,blocked};
}
