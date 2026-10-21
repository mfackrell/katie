import {supportsBoundedModel} from './compatibility';
import {rejectedBeforeInference} from './request-rejection';
import {getAvailableProviders} from '@/lib/providers';
import type {LlmProvider} from '@/lib/providers/types';
import {chooseProvider} from '@/lib/router/master-router';
import {filterProvidersBySharedHealth,recordSharedProviderFailure} from '@/lib/router/provider-health';
import {boundedProvider} from './bounded-provider';
import {classifyGenerationFailure} from '@/lib/router/provider-error';

export type OrchestrationChoice={provider:LlmProvider;modelId:string;reasoning:string};
/** Shared by EO management and ALL mission-backed child orchestrators. No saved model pins. */
type Accounting={reserve:(model:string,tokens:number)=>Promise<string>;finish:(id:string,tokens:number|null)=>Promise<void>};
export async function orchestrationChoices(input:{objective:string;instruction:string;requestId:string;research?:boolean;review?:boolean;planning?:boolean;synthesis?:boolean;accounting?:Accounting}):Promise<OrchestrationChoice[]>{
 const health=await filterProvidersBySharedHealth(getAvailableProviders());
 // Gemini grounding currently has no server-enforced per-request search-use cap.
 // Never silently remove a mission's hard tool budget to enable another model.
 const inventory=new Map<string,Set<string>>();
 const discovered=await Promise.allSettled(health.providers.map(async provider=>{
  const models=await provider.listModels();
  return{provider,models:new Set(models.map(id=>id.replace(/^models\//,'')).filter(id=>supportsBoundedModel(provider.name,id)))};
 }));
 for(const result of discovered)if(result.status==='fulfilled')inventory.set(result.value.provider.name,result.value.models);
 // Registry metadata ranks quality; it cannot confer current account access or
 // make a model support this transport. Failed discovery is not permission to guess.
 const providers=health.providers.filter(p=>inventory.get(p.name)?.size&&(!input.research||p.name!=='google')).map(provider=>({
  name:provider.name,listModels:async()=>[...inventory.get(provider.name)!],

  // Router classification and selection are inference too: use bounded native
  // transports and the SAME mission call ledger as execution, not chat adapters.
  generate:async(params)=>{
   if(!params.modelId)throw Error('Routing decision requires an explicit verified model');
   const request={model:params.modelId,instructions:params.persona,
    input:[...params.history,{role:'user',content:params.summary+'\n'+params.user}],max_output_tokens:2000,store:false};
   if(JSON.stringify(request).length>96000)throw Error('Routing context exceeds bounded input');
   const client=boundedProvider({provider,modelId:params.modelId,reasoning:'routing decision'});
   const countInput:Record<string,unknown>={...request};delete countInput.max_output_tokens;delete countInput.store;
   const counted=await Promise.resolve().then(()=>client.post('/responses/input_tokens',{body:countInput,timeout:15000})).catch(()=>null);
   const inputTokens=counted&&Number.isSafeInteger(counted.input_tokens)&&counted.input_tokens>=0
    ?counted.input_tokens+256:Buffer.byteLength(JSON.stringify(request),'utf8');
   const reservation=await input.accounting?.reserve(provider.name+':'+params.modelId,inputTokens+2000);
   try{
    const result=await client.responses.create(request,{timeout:30_000});
    if(reservation)await input.accounting!.finish(reservation,result.usage?.total_tokens??null);
    if(result.status!=='completed'||!result.output_text?.trim())throw Error('Routing decision incomplete');
    return{text:result.output_text,model:params.modelId,provider:provider.name};
   }catch(error){if(reservation)await input.accounting!.finish(reservation,rejectedBeforeInference(error)?0:null);throw error;}
  }
 } satisfies LlmProvider));
 if(!providers.length)throw Error('No connected provider supports the required bounded orchestration tools');
 const decision=await chooseProvider(input.objective+'\n'+input.instruction,
  'Autonomous assignment. Choose the strongest available model/submodel for this exact task, not the cheapest default. '+
  (input.research?'Native live web search with cited receipts required. ':'')+
  (input.review?'Independent substantive verification; prioritize reasoning depth. ':''),providers,{
   // Native token counting, reservation, generation and settlement must finish
   // before the router abandons a decision. The ordinary chat 12s race used to
   // discard charged, successful responses and start overlapping fallbacks.
   routingRequestId:input.requestId,decisionTimeoutMs:60000,candidateAllowed:(provider,model)=>inventory.get(provider)?.has(model.replace(/^models\//,''))===true,diverseFallbackProviders:true,decisionCandidatesPerProvider:4,
   ...(input.research?{requestIntent:'web-search' as const}:input.review?{requestIntent:'assistant-reflection' as const}:input.planning?{requestIntent:'architecture-review' as const}:input.synthesis?{requestIntent:'general-text' as const}:{})

  });
 const ranked=[{provider:decision.provider,modelId:decision.modelId},...decision.fallbackChain];
 const seen=new Set<string>();
 const allowed=ranked.filter(c=>providers.some(p=>p.name===c.provider.name)&&inventory.get(c.provider.name)?.has(c.modelId.replace(/^models\//,'')));

 const primary=allowed.filter(c=>{if(seen.has(c.provider.name))return false;seen.add(c.provider.name);return true;});
 const keys=new Set(primary.map(c=>c.provider.name+':'+c.modelId));
 const choices=[...primary,...allowed.filter(c=>!keys.has(c.provider.name+':'+c.modelId))].slice(0,6)
  .map(c=>({...c,reasoning:decision.reasoning}));
 console.info('[Orchestration] Task routing',{requestId:input.requestId,choices:choices.map(c=>c.provider.name+':'+c.modelId),reason:decision.reasoning});
 return choices;
}
export async function orchestrationFailure(choice:OrchestrationChoice,error:unknown){
 await recordSharedProviderFailure(choice.provider.name,error);
 return classifyGenerationFailure(error);
}
