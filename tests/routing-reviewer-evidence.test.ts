import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import * as admin from '@/lib/data/supabase/admin';
import { resolveReviewerRoutingEvidence } from '@/lib/router/reviewer-evidence';
import { runWithStandaloneAccounting, getAccountingScope } from '@/lib/standalone-accounting/context';
import { OpenAiProvider } from '@/lib/providers/openai-provider';
import { ClaudeProvider } from '@/lib/providers/claude-provider';
import * as economics from '@/lib/router/control-plane-economics';
import { chooseRoutingWithLLM, type CandidateMetadata, type RequestIntent } from '@/lib/router/model-intent';
import { PRICING_SNAPSHOT } from '@/lib/standalone-accounting/pricing';

const scope={userId:'owner',actorId:'actor',chatId:'chat',requestId:'current'};
const candidates=[{providerName:'openai',modelId:'gpt-4o-mini'},{providerName:'anthropic',modelId:'claude-sonnet-4-6'}];
test('review evidence uses authenticated scope, projects only aggregates, and fails unknown',async()=>{
 let calls=0;let error=false;
 const rpc=mock.method(admin,'getSupabaseAdminClient',()=>({rpc:async(name:string,args:unknown)=>{
  calls++;assert.equal(name,'standalone_routing_reviewer_evidence');
  assert.deepEqual(args,{p_owner:'owner',p_actor:'actor',p_chat:'chat',p_request:'current',p_intent:'rewrite'});
  return error?{error:{message:'unavailable'}}:{data:{observations:[{provider:'openai',model:'gpt-4o-mini',sample_count:2,approvals:1,revisions:1,first_observation:'2026-11-16',latest_observation:'2026-11-17',draft:'PRIVATE CONTENT',reviewer:'PRIVATE ID'},{provider:'other',model:'unlisted'}]}};
 }}));
 try{
  assert.equal((await resolveReviewerRoutingEvidence('rewrite',candidates)).status,'unknown');assert.equal(calls,0);
  await runWithStandaloneAccounting(scope,async()=>{
   const result=await resolveReviewerRoutingEvidence('rewrite',candidates);
   assert.equal(result.observations.length,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
   assert.match(JSON.stringify(result),/independent_model_reviewer_with_prior_assessment/);
   error=true;assert.equal((await resolveReviewerRoutingEvidence('rewrite',candidates)).status,'unknown');
   assert.equal((getAccountingScope() as {counter:Map<string,number>}).counter.size,0);
  });
 }finally{rpc.mock.restore();}
});

const tasks: Array<[string, RequestIntent]> = [
 ['Hello Katie','general-text'], ['Write a board memo','rewrite'],
 ['Implement payment recovery','code-generation'], ['Continue this poem','rewrite'],
 ['Write an emotionally careful reply','social-emotional'], ['Explain the screenshot','multimodal-reasoning'],
];
for(const [task,intent] of tasks){
 test(`Stage 2 receives scoped review evidence and retains native quotation: ${task}`,async()=>{
  const originalRank=economics.rankControlPlaneByActualCost;
  const adapters=[{provider:new OpenAiProvider('test-key'),modelId:'gpt-5-mini'},
   {provider:new ClaudeProvider('test-key'),modelId:'claude-sonnet-4-6'}];
  const metadata: CandidateMetadata[]=adapters.map(({provider,modelId})=>({
   providerName:provider.name,modelId,supports_text:true,supports_web_search:false,
   supports_vision:true,supports_video:false,supports_image_generation:false,
   reasoning_depth_tier:'high',speed_tier:'medium',cost_tier:'medium',specialization_tags:[],prior_score:1,
  }));
  let available=true,decisions=0,quotes=0;
  const rpc=mock.method(admin,'getSupabaseAdminClient',()=>({rpc:async(name:string,args:Record<string,string>)=>{
   assert.equal(name,'standalone_routing_reviewer_evidence');
   assert.equal(args.p_intent,intent);assert.equal(args.p_owner,scope.userId);
   assert.equal(args.p_actor,scope.actorId);assert.equal(args.p_chat,scope.chatId);
   assert.equal(args.p_request,scope.requestId);
   return {data:{observations:available?[{provider:'openai',model:'gpt-5-mini',sample_count:2,
    approvals:2,revisions:0,first_observation:'2026-11-16',latest_observation:'2026-11-17',
    reviewer:'PRIVATE ID',draft:'PRIVATE ANSWER'}]:[]}};
  }}));
  const rank=mock.method(economics,'rankControlPlaneByActualCost',async(input: Parameters<typeof originalRank>[0],params: Parameters<typeof originalRank>[1])=>{
   assert.equal(input.length,2);
   const priced=await originalRank(input,params,PRICING_SNAPSHOT);
   assert.equal(priced.length,2,'both native adapters must yield a priced serialized request');
   assert.equal((getAccountingScope() as {counter:Map<string,number>}).counter.size,0);
   quotes++;return priced;
  });
  const generators=adapters.map(({provider,modelId})=>{
   const generate=provider.generate.bind(provider);
   return mock.method(provider,'generate',async (params: Parameters<typeof generate>[0])=>{
    if(economics.isCapturingControlPlanePreparation())return generate(params);
    const payload=JSON.parse(params.user.slice(params.user.indexOf('\n\n{')+2));
    assert.equal(payload.prompt,task);assert.equal(payload.candidates.length,2);
    const evidence=payload.reviewer_quality_evidence;
    assert.equal(evidence.status,available?'limited reviewer verdict evidence':'unknown');
    assert.equal(evidence.observations.length,available?1:0);
    assert.doesNotMatch(JSON.stringify(evidence),/PRIVATE/);
    if(available){
     assert.equal(evidence.observations[0].sample_count,2);
     assert.equal(evidence.observations[0].provenance,'independent_model_reviewer_with_prior_assessment');
     assert.equal(evidence.window_days,30);assert.match(evidence.uncertainty,/Selection-biased/);
    }
    decisions++;
    // Deliberately choose the other provider despite all approvals belonging to OpenAI.
    const selected=available?metadata[1]:metadata[0];
    return {text:JSON.stringify({selected:{provider:selected.providerName,model:selected.modelId},
     selection_justification:'Mocked task-fit decision with uncertainty'}),provider:provider.name,model:modelId};
   });
  });
  const fetch=mock.method(globalThis,'fetch',async()=>{throw Error('No paid or external calls');});
  try{await runWithStandaloneAccounting(scope,async()=>{
   for(const hasEvidence of [true,false]){
    available=hasEvidence;
    const result=await chooseRoutingWithLLM({prompt:task,intent,candidates:metadata,decisionProviders:adapters,
     modalityFlags:{has_images:intent==='multimodal-reasoning',has_video_input:false},
     hardRouteContext:{hard_rule_applied:false,rule:'none'},preferenceProfile:{
      prioritize_best_model_for_task:true,quality_over_cost_for:[],prefer_efficient_for:[],
      use_specialization_when_relevant:true,avoid_cost_or_speed_dominance_for_depth_tasks:true,
      hard_constraints_are_non_negotiable:true,
     }});
    assert.equal(result.accepted,true);
    assert.deepEqual(result.selected,hasEvidence?{providerName:'anthropic',modelId:metadata[1].modelId}:
     {providerName:'openai',modelId:metadata[0].modelId});
   }
   assert.equal((getAccountingScope() as {counter:Map<string,number>}).counter.size,0);
  });
   assert.equal(quotes,2);assert.equal(decisions,2);assert.equal(fetch.mock.callCount(),0);
  }finally{fetch.mock.restore();generators.forEach(g=>g.mock.restore());rank.mock.restore();rpc.mock.restore();}
 });
}
