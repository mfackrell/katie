// Intent must EXPLICITLY be to create or manage a specialist orchestrator.
// Never intercept ordinary requests for finance analyses, research, software,
// dashboards or documents, which belong to regular task routing.
export function specialistCreationIntent(message:string){
 const cleaned=message.trim().replace(/^please\s+/i,'').replace(/^(?:can|could|would|will) you\s+(?:please\s+)?/i,'');
 const match=/^(?:i (?:want|need|would like) (?:you to )?|go ahead and |proceed (?:to )?(?:with )?)?(?:create|configure|set up|setup|provision|establish|add|build)\s+(?:me\s+)?(?:a |an |the |new |specialized |specialist )*([a-z][a-z\s-]{1,65}?)\s+(?:specialist )?(?:orchestrator|sub-orchestrator)\b[.!?\s]*$/i.exec(cleaned);
 if(!match)return null;
 const domain=match[1].trim().toLowerCase().replace(/\s+/g,' ');
 if(/^(?:a|an|another|new|more|some|that|this|one|the)$/i.test(domain))return null;
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
 const {startSpecialistFactory}=await import('./factory-runtime');
 return startSpecialistFactory({...input,intent});
}
