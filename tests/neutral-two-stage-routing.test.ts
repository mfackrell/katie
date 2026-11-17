import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as economics from '@/lib/router/control-plane-economics';
import { runWithStandaloneAccounting } from '@/lib/standalone-accounting/context';
import { chooseProvider } from '@/lib/router/master-router';
import { buildCandidateMetadata, buildNeutralDecisionEvidence, inferRequestClassificationWithSource, type RequestIntent } from '@/lib/router/model-intent';
import type { LlmProvider } from '@/lib/providers/types';
import type { RegistryRoutingModel } from '@/lib/models/registry';
import { createNeutralActorRoutingProfile } from '@/lib/router/actor-routing-profile';

const owner = {userId:'owner-test', actorId:'actor-test', chatId:'chat-test', requestId:'request-test'};
const models = {openai:['gpt-5.4','gpt-5-mini','gpt-4o-mini'], anthropic:['claude-sonnet-4-6'], google:['gemini-2.5-flash'], grok:['grok-4.3']} as const;
function registry(): Map<LlmProvider['name'], RegistryRoutingModel[]> {
  return new Map(Object.entries(models).map(([provider, ids]) => [provider as LlmProvider['name'], ids.map(model => ({
    provider_name:provider, model_id:model, pricing_status:'verified', capability_status:'verified',
    routing_eligibility:'verified', confidence_tier:'high', confidence_score:1,
    supports_text:true, supports_vision:!/-mini$/.test(model), supports_video:provider==='google',
    supports_image_generation:false, supports_web_search:provider==='grok',
    reasoning_tier:'high', speed_tier:'fast', cost_tier:'low', pricing_input_per_1m:null, pricing_output_per_1m:null,
  } as RegistryRoutingModel))]));
}
const fixtures: Array<{message:string; intent:RequestIntent; complexity:'low'|'high'; context?:string}> = [
  {message:'Hello Katie',intent:'general-text',complexity:'low'},
  {message:'Rewrite this for the board after verifying the finance model and covenant math',intent:'general-text',complexity:'high'},
  {message:'Implement idempotent multi-region payment recovery',intent:'code-generation',complexity:'high'},
  {message:'yes, continue',intent:'rewrite',complexity:'high',context:'Actor persona: warm. Memory: board memo must reconcile debt covenants. Pending work: finish the rigorous financial analysis.'},
  {message:'I feel abandoned but please help me compose a careful reply',intent:'social-emotional',complexity:'high'},
  {message:'Write a surprising poem in the same voice',intent:'rewrite',complexity:'high',context:'Prior poem and actor voice supplied here'},
  {message:'The variable newsSummary breaks the architecture joke in my poem; polish the wording',intent:'rewrite',complexity:'low'},
];

for (const mode of ['best_value','best_answer'] as const) {
  for (const fixture of fixtures) test(`${mode}: LLM has both authorities: ${fixture.message}`, async () => {
    const rank = mock.method(economics,'rankControlPlaneByActualCost', async (candidates: unknown[]) => candidates);
    const calls:string[]=[];
    const providers = Object.entries(models).map(([name, ids]) => ({name, listModels:async()=>[...ids], generate:async(params) => {
      calls.push(params.user);
      if (params.user.includes('CURRENT_USER_MESSAGE:')) return {text:JSON.stringify({intent:fixture.intent, complexity:fixture.complexity, primary_objective:'fixture objective', objective_evidence:[fixture.message], context_influence:'supplied memory'}),provider:name,model:params.modelId!};
      const payload=JSON.parse(params.user.slice(params.user.indexOf('\n\n')+2));
      assert.equal(payload.routing_mode, mode);
      assert.equal(payload.understanding.intent, fixture.intent);
      assert.equal(payload.understanding.complexity, fixture.complexity);
      assert.equal(payload.understanding.decisionEvidence.classification_provider, name);
      assert.equal(payload.candidates.length,6,'per-provider shortlist must not hide models');
      assert.deepEqual(new Set(payload.candidates.map((c:{provider:string})=>c.provider)),new Set(Object.keys(models)));
      assert.doesNotMatch(JSON.stringify(payload),/prior_score|score_breakdown|providerBoosts|specialization_tags|preference_profile/);
      if(fixture.context) assert.match(payload.conversation_context,/Memory|voice/);
      return {text:JSON.stringify({selected:{provider:'grok',model:'grok-4.3'},selection_justification:'Mock evidence chooses a different provider from historical rankings'}),provider:name,model:params.modelId!};
    }} as LlmProvider));
    const actor = createNeutralActorRoutingProfile();actor.providerBoosts.anthropic=3;
    try {
      const result=await runWithStandaloneAccounting(owner,()=>chooseProvider(fixture.message,fixture.context??'',providers,{
        modelRegistrySnapshot:registry(), routing_mode:mode, actorRoutingProfile:actor, decisionCandidatesPerProvider:1,
      }));
      assert.equal(calls.length,2,'separate understanding and selection calls');
      assert.equal(result.resolvedIntent.intent,fixture.intent);
      assert.equal(result.authority,'llm');
      assert.equal(result.provider.name,'grok','policy must not replace the LLM winner');
      assert.equal(result.explainer?.selected_source,'llm-primary');
    } finally {rank.mock.restore();}
  });
}

test('invalid selection is corrected once; unavailable decision models disclose fallback',async()=>{
  const rank=mock.method(economics,'rankControlPlaneByActualCost',async(candidates:unknown[])=>candidates);
  let selections=0;
  const provider:LlmProvider={name:'openai',listModels:async()=>[...models.openai],generate:async p=>{
    if(p.user.includes('CURRENT_USER_MESSAGE:'))return {text:'{"intent":"general-text"}',provider:'openai',model:p.modelId!};
    assert.match(p.user, /"routing_mode":"best_value"/);
    selections++;
    if(selections===1)return {text:'{"selected":{"provider":"anthropic","model":"not-eligible"}}',provider:'openai',model:p.modelId!};
    assert.match(p.user,/CORRECTION:/);
    return {text:'{"selected":{"provider":"openai","model":"gpt-5-mini"}}',provider:'openai',model:p.modelId!};
  }};
  try {
    const result=await runWithStandaloneAccounting(owner,()=>chooseProvider('Hi','',[provider],{modelRegistrySnapshot:registry()}));
    assert.equal(result.modelId,'gpt-5-mini');assert.equal(selections,2);
    rank.mock.mockImplementation(async()=>[]);
    const failed=await runWithStandaloneAccounting(owner,()=>chooseProvider('Hi','',[provider],{modelRegistrySnapshot:registry()}));
    assert.equal(failed.explainer?.selected_source,'deterministic-fallback');
    assert.equal(failed.explainer?.fallback_used,true);
  } finally {rank.mock.restore();}
});

test('multimedia classification remains LLM-owned despite chart keyword',async()=>{
  const rank=mock.method(economics,'rankControlPlaneByActualCost',async(candidates:unknown[])=>candidates);
  const provider:LlmProvider={name:'openai',listModels:async()=>['gpt-5.4'],generate:async p=>({text:'{"intent":"vision-analysis","complexity":"low"}',provider:'openai',model:p.modelId!})};
  try {for(const input of [{hasImages:true},{hasImages:false,hasVideoInput:true}]) {
    const result=await runWithStandaloneAccounting(owner,()=>inferRequestClassificationWithSource('Describe the chart colors',input,{decisionProviders:[{provider,modelId:'gpt-5.4'}]}));
    assert.equal(result.source,'llm');assert.equal(result.classification.intent,'vision-analysis');
  }}finally{rank.mock.restore();}
});

test('reviewed price estimates use tiered input/output rates and disclose cache, retry and quality unknowns',()=>{
  const evidence=buildNeutralDecisionEvidence(buildCandidateMetadata('openai','gpt-5.4','general-text'),'a'.repeat(4000));
  assert.equal(evidence.pricing?.scenario.estimated_micro_usd,'17860');
  assert.equal(evidence.pricing?.cached_input_nano_usd,'250');
  assert.equal(evidence.context_limit_tokens,1050000);
  const longContext=buildNeutralDecisionEvidence(buildCandidateMetadata('openai','gpt-5.4','general-text'),'a'.repeat(272001*4));
  assert.equal(longContext.pricing?.scenario.estimated_micro_usd,'1383045');
  assert.match(evidence.comparative_quality.status,/unknown/);
  const unknown=buildNeutralDecisionEvidence(buildCandidateMetadata('grok','unknown-model','general-text'),'Hi');
  assert.equal(unknown.pricing,null);assert.equal(unknown.capabilities,null);
});

for(const video of [false,true]) test(`${video?'video':'image'} compatibility constrains LLM candidates independently of classification`,async()=>{
  const rank=mock.method(economics,'rankControlPlaneByActualCost',async(candidates:unknown[])=>candidates);
  const providers=Object.entries(models).map(([name,ids])=>({name,listModels:async()=>[...ids],generate:async p=>{
    if(p.user.includes('CURRENT_USER_MESSAGE:'))return {text:'{"intent":"general-text"}',provider:name,model:p.modelId!};
    const payload=JSON.parse(p.user.slice(p.user.indexOf('\n\n')+2));
    assert.ok(payload.candidates.every((c:{capabilities:{vision:boolean;video:boolean}})=>video?c.capabilities.video:c.capabilities.vision));
    if(video)assert.deepEqual(payload.candidates.map((c:{provider:string})=>c.provider),['google']);
    return {text:'{"selected":{"provider":"google","model":"gemini-2.5-flash"}}',provider:name,model:p.modelId!};
  }} as LlmProvider));
  try {
    const result=await runWithStandaloneAccounting(owner,()=>chooseProvider('Describe this','',providers,{modelRegistrySnapshot:registry(),hasImages:!video,hasVideoInput:video}));
    assert.equal(result.provider.name,'google');
    assert.equal(result.explainer?.selected_source,'llm-primary');
  }finally{rank.mock.restore();}
});

test('terminal accounting denial cannot become a correction or local routing fallback',async()=>{
  const rank=mock.method(economics,'rankControlPlaneByActualCost',async(candidates:unknown[])=>candidates);
  const terminal=Object.assign(new Error('budget exhausted'),{terminal:true,code:'standalone_budget_exhausted'});
  let calls=0;
  const provider:LlmProvider={name:'openai',listModels:async()=>[...models.openai],generate:async p=>{
    calls++;
    if(p.user.includes('CURRENT_USER_MESSAGE:'))return {text:'{"intent":"general-text"}',provider:'openai',model:p.modelId!};
    throw terminal;
  }};
  try {
    await assert.rejects(runWithStandaloneAccounting(owner,()=>chooseProvider('Hi','',[provider],{modelRegistrySnapshot:registry()})),error=>error===terminal);
    assert.equal(calls,2);
  } finally{rank.mock.restore();}
});

test('every eligible provider can win without a family or provider override',async()=>{
  const rank=mock.method(economics,'rankControlPlaneByActualCost',async(candidates:unknown[])=>candidates);
  let selected='';
  const providers=Object.entries(models).map(([name,ids])=>({name,listModels:async()=>[...ids],generate:async p=>({
    text:p.user.includes('CURRENT_USER_MESSAGE:')?'{"intent":"rewrite","complexity":"high"}':JSON.stringify({selected:{provider:selected,model:models[selected as keyof typeof models][0]}}),
    provider:name,model:p.modelId!,
  })} as LlmProvider));
  try {
    for(const name of Object.keys(models)){
      selected=name;
      const result=await runWithStandaloneAccounting(owner,()=>chooseProvider('Continue the scene in my voice','Actor: distinctive voice. Memory: prior scene.',providers,{modelRegistrySnapshot:registry()}));
      assert.equal(result.provider.name,name);
      assert.equal(result.explainer?.selected_source,'llm-primary');
    }
  }finally{rank.mock.restore();}
});
