import {createHash} from 'node:crypto';
import {planExecutiveProvisioning,configureExecutiveSpecialist} from './provisioning-service';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {capabilityRequirement} from './provisioning';

// Intent must EXPLICITLY be to create or manage a specialist orchestrator.
// Never intercept ordinary requests for finance analyses, research, software,
// dashboards or documents, which belong to regular task routing.
export function specialistCreationIntent(message:string){
 const cleaned=message.trim().replace(/^please\s+/i,'').replace(/^(?:can|could|would|will) you\s+(?:please\s+)?/i,'');
 const match=/^(?:i (?:want|need|would like) (?:you to )?|go ahead and |proceed (?:to )?(?:with )?)?(?:create|configure|set up|setup|provision|establish|add|build)\s+(?:me\s+)?(?:a |an |the |new |specialized |specialist )*([a-z][a-z\s-]{1,65}?)\s+(?:specialist )?(?:orchestrator|sub-orchestrator)\b[.!?\s]*$/i.exec(cleaned);
 if(!match)return null;
 const domain=match[1].trim().toLowerCase().replace(/\s+/g,' ');
 if(/^(?:another|new|more|some|that|this|one|the)$/i.test(domain))return null;
 const slug=domain.replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,40);
 if(!/^[a-z][a-z0-9_]{1,39}$/.test(slug))return null;
 // These are capability REQUESTS, not a claim that the tools exist.
 const known:Record<string,string>={finance:'financial_analysis',financial:'financial_analysis',
  research:'research_synthesis',operations:'operations_analysis',marketing:'marketing_strategy',
  legal:'legal_research',sales:'sales_analysis',hr:'people_operations',
  'human resources':'people_operations'};
 const capability=known[domain]??slug+'_coordination';
 if(capability.length>50)return null;
 return{domain,slug,capability};
}
function requestKey(requestId:string,message:string){
 const digest=createHash('sha256').update(requestId+'\n'+message).digest('hex');
 return 'exec-specialist-'+digest.slice(0,40);
}
export async function handleExecutiveSpecialistIntake(input:{
 actorId:string;chatId:string;message:string;requestId:string;
}):Promise<string|null>{
 const intent=specialistCreationIntent(input.message);
 if(!intent)return null;
 const title=intent.domain.replace(/\b[a-z]/g,s=>s.toUpperCase())+' Orchestrator';
 const requirement=capabilityRequirement.parse({
  capability:intent.capability,
  objective:'Establish a specialized '+intent.domain+' orchestrator that can execute independently assigned '+intent.domain+' objectives.',
  successCriteria:[
   'The specialist exposes a versioned executive delegation and progress-reporting contract.',
   'Its declared capabilities have independently verified acceptance evidence.',
   'The specialist is registered without exceeding approved permissions and is activated only after verification.'
  ],
  proposedSlug:intent.slug,proposedTitle:title,
  proposedDescription:'Specialized executive-supervised '+intent.domain+' coordination and delivery.',
  proposedCapabilities:[intent.capability]
 });
 const planned=await planExecutiveProvisioning({...input,requestKey:requestKey(input.requestId,input.message),requirement});
 if(planned.decision.route==='reuse')
  return 'An active '+title+' already supports this capability. I have recorded the executive provisioning decision and can delegate a specific objective to it. No new specialist is needed.';
 if(planned.decision.route==='configure'){
  const row=planned.request as {id?:string};
  if(!row.id)throw Error('Provisioning request identity missing');
  const configured=await configureExecutiveSpecialist({actorId:input.actorId,chatId:input.chatId,
   requestId:row.id,capabilityCatalogVerified:true});
  if(!configured)throw Error('Specialist configuration evidence unavailable');
  return 'I configured a new '+title+' using previously active, verified capabilities. It is registered but not activated. Its capabilities must pass independent acceptance before it can receive autonomous assignments.';
 }
 // Do not invent software builder authority, tools or executable adapters.
 // A builder can be commissioned only through a saved, ACTIVE executive specialist
 // that explicitly advertises specialist_build. This delegation is still a proposal.
 const db=getSupabaseAdminClient();
 const {data:builders,error}=await db.from('executive_orchestrators').select('slug,capabilities,status')
  .eq('actor_id',input.actorId).eq('status','active').limit(100);
 if(error)throw Error('Specialist builder inventory unavailable');
 const available=((builders??[]) as Array<{slug:string;capabilities:string[]}>)
  .filter(x=>x.capabilities.includes('specialist_build')).sort((a,b)=>a.slug.localeCompare(b.slug));
 if(!available.length)
  return 'I recorded the request to create a '+title+'. Katie currently has no active, verified specialist-builder capability, so it is awaiting that connection. I have not claimed that development has started or created an unapproved agent.';
 const plan=planned.request as {id?:string};
 if(!plan.id)throw Error('Provisioning request identity missing');
 const originalKey=requestKey(input.requestId,input.message);
 const deadline=new Date(Date.now()+7*86400000).toISOString();
 const {data:delegation,error:delegateError}=await db.rpc('propose_executive_delegation',{
  p_actor:input.actorId,p_chat:input.chatId,p_slug:available[0].slug,
  p_request:'commission-'+originalKey,p_objective:'Build and independently verify '+title+
   ' with capability '+intent.capability+'. Preserve approved security and deployment boundaries.',
  p_capability:'specialist_build',p_success:requirement.successCriteria,
  p_budget:0,p_deadline:deadline
 });
 if(delegateError||!delegation)throw Error('Specialist commission could not be recorded');
 const id=(delegation as {id?:string}).id;
 if(!id)throw Error('Specialist commission identity missing');
 const {data:bound,error:bindError}=await db.rpc('transition_executive_provisioning',{
  p_id:plan.id,p_actor:input.actorId,p_chat:input.chatId,p_action:'bind_commission',
  p_evidence:{commissionDelegationId:id}
 });
 if(bindError||!bound)throw Error('Specialist commission could not be bound to its executive request');
 return 'I commissioned a '+title+' through the registered specialist builder. The commission is a tracked executive proposal, not permission to start coding or deploy. Work must be separately authorized and independently verified before activation.';
}
