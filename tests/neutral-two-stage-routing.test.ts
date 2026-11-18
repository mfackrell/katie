import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as economics from '@/lib/router/control-plane-economics';
import * as qualityEvidence from '@/lib/router/observed-evidence';
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
function understanding(message:string, intent:RequestIntent = 'general-text', complexity:'low'|'high' = 'low') {
  return {intent, complexity, response_purpose:'deliverable', provider_refusal_risk:'low',
    quality_requirements:'Match the requested rigor, tone and specialized needs; disclose uncertainty.',
    primary_objective:'Respond to the supplied request', objective_evidence:[message],
    context_influence:'Consider supplied context when relevant; otherwise none.',
    selection_justification:'Task-specific assessment of the supplied request.'};
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
      if (params.user.includes('CURRENT_USER_MESSAGE:')) return {text:JSON.stringify(understanding(fixture.message, fixture.intent, fixture.complexity)),provider:name,model:params.modelId!};
      const payload=JSON.parse(params.user.slice(params.user.indexOf('\n\n')+2));
      assert.equal(payload.routing_mode, mode);
      assert.equal(payload.understanding.intent, fixture.intent);
      assert.equal(payload.understanding.complexity, fixture.complexity);
      assert.equal(payload.understanding.decisionEvidence.classification_provider, name);
      assert.equal(payload.candidates.length,6,'per-provider shortlist must not hide models');
      assert.deepEqual(new Set(payload.candidates.map((c:{provider:string})=>c.provider)),new Set(Object.keys(models)));
      assert.doesNotMatch(JSON.stringify(payload),/prior_score|score_breakdown|providerBoosts|specialization_tags|preference_profile/);
      if(fixture.context) assert.match(payload.conversation_context,/Memory|voice/);
      return {text:JSON.stringify({selected:{provider:'grok',model:'grok-4.3'},selection_justification:'Mock evidence chooses a different provider from historical rankings',alternatives:[{provider:'openai',model:'gpt-4o-mini',why_not_selected:'Lower cost alone does not establish equivalent task-specific response quality.'}]}),provider:name,model:params.modelId!};
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
    if(p.user.includes('CURRENT_USER_MESSAGE:'))return {text:JSON.stringify(understanding('Hi')),provider:'openai',model:p.modelId!};
    assert.match(p.user, /"routing_mode":"best_value"/);
    selections++;
    if(selections===1)return {text:'{"selected":{"provider":"anthropic","model":"not-eligible"}}',provider:'openai',model:p.modelId!};
    assert.match(p.user,/CORRECTION:/);
    return {text:'{"selected":{"provider":"openai","model":"gpt-5-mini"},"selection_justification":"Meets the task quality requirements at the supplied estimated cost; comparative quality is uncertain.","alternatives":[{"provider":"openai","model":"gpt-5.4","why_not_selected":"Additional reasoning capacity is unnecessary given the task requirements."}]}',provider:'openai',model:p.modelId!};
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
  const provider:LlmProvider={name:'openai',listModels:async()=>['gpt-5.4'],generate:async p=>({text:JSON.stringify(understanding('Describe the chart colors','vision-analysis')),provider:'openai',model:p.modelId!})};
  try {for(const input of [{hasImages:true},{hasImages:false,hasVideoInput:true}]) {
    const result=await runWithStandaloneAccounting(owner,()=>inferRequestClassificationWithSource('Describe the chart colors',input,{decisionProviders:[{provider,modelId:'gpt-5.4'}]}));
    assert.equal(result.source,'llm');assert.equal(result.classification.intent,'vision-analysis');
  }}finally{rank.mock.restore();}
});

test('reviewed price estimates use tiered input/output rates and disclose cache, retry and quality unknowns',()=>{
  const evidence=buildNeutralDecisionEvidence(buildCandidateMetadata('openai','gpt-5.4','general-text'),'a'.repeat(4000));
  assert.deepEqual(evidence.pricing?.scenario, {status: 'unknown', reason: 'Serialized request unavailable; no fabricated cost scenario'});
  assert.equal(evidence.pricing?.cached_input_nano_usd,'250');
  assert.equal(evidence.context_limit_tokens,1050000);
  const longContext=buildNeutralDecisionEvidence(buildCandidateMetadata('openai','gpt-5.4','general-text'),'a'.repeat(272001*4));
  assert.deepEqual(longContext.pricing?.scenario, evidence.pricing?.scenario);
  assert.match(evidence.comparative_quality.status,/unknown/);
  const unknown=buildNeutralDecisionEvidence(buildCandidateMetadata('grok','unknown-model','general-text'),'Hi');
  assert.equal(unknown.pricing,null);assert.equal(unknown.capabilities,null);
});

for(const video of [false,true]) test(`${video?'video':'image'} compatibility constrains LLM candidates independently of classification`,async()=>{
  const rank=mock.method(economics,'rankControlPlaneByActualCost',async(candidates:unknown[])=>candidates);
  const providers=Object.entries(models).map(([name,ids])=>({name,listModels:async()=>[...ids],generate:async p=>{
    if(p.user.includes('CURRENT_USER_MESSAGE:'))return {text:JSON.stringify(understanding('Describe this')),provider:name,model:p.modelId!};
    const payload=JSON.parse(p.user.slice(p.user.indexOf('\n\n')+2));
    assert.ok(payload.candidates.every((c:{capabilities:{vision:boolean;video:boolean}})=>video?c.capabilities.video:c.capabilities.vision));
    if(video)assert.deepEqual(payload.candidates.map((c:{provider:string})=>c.provider),['google']);
    return {text:'{"selected":{"provider":"google","model":"gemini-2.5-flash"},"selection_justification":"Eligible multimedia capability meets the observed task requirements.","alternatives":[{"provider":"openai","model":"gpt-5.4","why_not_selected":"Alternative can handle images but is less economical for the current mocked task."}]}',provider:name,model:p.modelId!};
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
    if(p.user.includes('CURRENT_USER_MESSAGE:'))return {text:JSON.stringify(understanding('Hi')),provider:'openai',model:p.modelId!};
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
    text:p.user.includes('CURRENT_USER_MESSAGE:')?JSON.stringify(understanding('Continue the scene in my voice','rewrite','high')):JSON.stringify({selected:{provider:selected,model:models[selected as keyof typeof models][0]},selection_justification:"Task-specific mock evidence supports this selection with uncertain comparative quality.",alternatives:[{provider:selected==='openai'?'anthropic':'openai',model:selected==='openai'?'claude-sonnet-4-6':'gpt-5.4',why_not_selected:'Alternative is eligible, but evidence for equivalent quality in this mocked task is uncertain.'}]}),
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

for (const field of ['quality_requirements','complexity','response_purpose','provider_refusal_risk','primary_objective','objective_evidence','context_influence','selection_justification','intent-only','unquoted-evidence']) {
  test(`incomplete understanding (${field}) is corrected before stage two`,async()=>{
    const rank=mock.method(economics,'rankControlPlaneByActualCost',async(candidates:unknown[])=>candidates);
    let analyses=0;let selections=0;
    const provider:LlmProvider={name:'openai',listModels:async()=>[...models.openai],generate:async p=>{
      if(p.user.includes('CURRENT_USER_MESSAGE:')) {
        analyses++;
        const analysis:Record<string,unknown>=understanding('Hi');
        if(analyses===1) {
          if(field==='intent-only')for(const key of Object.keys(analysis)){if(key!=='intent')delete analysis[key];}
          else if(field==='unquoted-evidence')analysis.objective_evidence=['invented user request'];
          else delete analysis[field];
        }else assert.match(p.user,/CORRECTION:/);
        return {text:JSON.stringify(analysis),provider:'openai',model:p.modelId!};
      }
      selections++;
      const payload=JSON.parse(p.user.slice(p.user.indexOf('\n\n')+2));
      assert.equal(analyses,2);
      assert.equal(payload.understanding.complexity,'low');
      assert.equal(payload.understanding.decisionEvidence.primary_objective,understanding('Hi').primary_objective);
      return {text:'{"selected":{"provider":"openai","model":"gpt-5-mini"},"selection_justification":"Meets the task quality requirements at the supplied estimated cost; comparative quality is uncertain.","alternatives":[{"provider":"openai","model":"gpt-5.4","why_not_selected":"Additional reasoning capacity is unnecessary given the task requirements."}]}',provider:'openai',model:p.modelId!};
    }};
    try {
      const result=await runWithStandaloneAccounting(owner,()=>chooseProvider('Hi','',[provider],{modelRegistrySnapshot:registry()}));
      assert.equal(result.authority,'llm');assert.equal(analyses,2);assert.equal(selections,1);
    }finally{rank.mock.restore();}
  });
}

test('persistently incomplete understanding exhausts bounded correction and discloses fallback',async()=>{
  const rank=mock.method(economics,'rankControlPlaneByActualCost',async(candidates:unknown[])=>candidates);
  let calls=0;
  const provider:LlmProvider={name:'openai',listModels:async()=>['gpt-5.4'],generate:async p=>{
    calls++;return {text:'{"intent":"general-text"}',provider:'openai',model:p.modelId!};
  }};
  try {
    const result=await runWithStandaloneAccounting(owner,()=>inferRequestClassificationWithSource('Hi',false,{decisionProviders:[{provider,modelId:'gpt-5.4'}]}));
    assert.equal(calls,2);assert.equal(result.source,'router-fallback');
    assert.equal(result.classification.decisionEvidence,undefined);
  }finally{rank.mock.restore();}
});

test('stage two never sees a fallback category as validated understanding', async () => {
  const rank=mock.method(economics,'rankControlPlaneByActualCost',async(candidates:unknown[])=>candidates);
  let analyses=0;
  const provider:LlmProvider={name:'openai',listModels:async()=>['gpt-5.4'],generate:async p=>{
    assert.match(p.user,/CURRENT_USER_MESSAGE:/,'selection must not execute after inadequate understanding');
    analyses++;
    return {text:'{"intent":"general-text"}',provider:'openai',model:p.modelId!};
  }};
  try {
    const result=await runWithStandaloneAccounting(owner,()=>chooseProvider('Hi','',[provider],{modelRegistrySnapshot:registry()}));
    assert.equal(analyses,3, 'two eligible helper models plus one correction');
    assert.equal(result.explainer?.selected_source,'deterministic-fallback');
    assert.equal(result.explainer?.fallback_reason,'stage_one_understanding_unavailable');
    assert.equal(result.explainer?.fallback_used,true);
  } finally {rank.mock.restore();}
});

test('terminal Stage 1 accounting denial cannot enter a local fallback', async () => {
  const rank=mock.method(economics,'rankControlPlaneByActualCost',async(candidates:unknown[])=>candidates);
  const terminal=Object.assign(new Error('budget exhausted'),{terminal:true,code:'standalone_budget_exhausted'});
  let calls=0;
  const provider:LlmProvider={name:'openai',listModels:async()=>['gpt-5.4'],generate:async()=>{calls++;throw terminal;}};
  try {
    await assert.rejects(runWithStandaloneAccounting(owner,()=>chooseProvider('Hi','',[provider],{modelRegistrySnapshot:registry()})), error=>error===terminal);
    assert.equal(calls,1);
  } finally {rank.mock.restore();}
});


test('user objective, constraints and model-specific outcome evidence reach the LLM selector unchanged',async()=>{
  const rank = mock.method(economics,'rankControlPlaneByActualCost',async(candidates:unknown[])=>candidates);
  const original = 'Continue the established creative story in my voice';
  const evidence = mock.method(qualityEvidence,'resolveRoutingEvidence',async(candidates:Array<{providerName:string;modelId:string}>,_providers:unknown,_params:unknown,intent:string)=>{
    assert.equal(intent,'rewrite');
    return {overhead:{status:'unknown'},candidates:Object.fromEntries(candidates.map(candidate=>{
      const grok=candidate.providerName==='grok' && candidate.modelId==='grok-4.3';
      return [candidate.providerName+':'+candidate.modelId,{
        quality:grok?{status:'limited, model-attributed task feedback',observations:[],
          feedback:{positive:2,negative:0,ambiguous:0,evidence:[
            {source:'message_reaction',source_id:'reaction-1',observed_at:new Date().toISOString(),
              dimension:'user_satisfaction',outcome:'positive',confidence:'direct_response_reaction',task_excerpt:original}
          ],uncertainty:'Task-specific, not a universal quality ranking'}}:{status:'unknown',observations:[]},
        economics:{status:'unknown'}
      }];
    }))};
  });
  let selections=0;
  const providers=Object.entries(models).map(([name,ids])=>({name,listModels:async()=>[...ids],generate:async p=>{
    if(p.user.includes('CURRENT_USER_MESSAGE:')) return {
      text:JSON.stringify({...understanding(original,'rewrite','high'),primary_objective:original,
        response_constraints:'Existing provider policy and safety limits remain binding.'}),
      provider:name,model:p.modelId!,
    };
    selections++;
    const payload=JSON.parse(p.user.slice(p.user.indexOf('\n\n')+2));
    assert.equal(payload.understanding.decisionEvidence.primary_objective,original);
    assert.match(payload.understanding.decisionEvidence.response_constraints,/policy and safety/);
    assert.equal(payload.candidates.find((c:{provider:string;model:string;comparative_quality:{feedback?:{positive:number}}})=>c.provider==='grok'&&c.model==='grok-4.3')
      .comparative_quality.feedback.positive,2);
    assert.deepEqual(payload.candidates.find((c:{provider:string;model:string;comparative_quality:{feedback?:{positive:number}}})=>c.provider==='openai'&&c.model==='gpt-5-mini')
      .comparative_quality,{status:'unknown',observations:[]});
    return {text:JSON.stringify({selected:{provider:'grok',model:'grok-4.3'},
      selection_justification:'Task-specific direct user reaction favors Grok; price and reasoning metadata do not establish better quality for alternatives.',
      alternatives:[{provider:'openai',model:'gpt-5-mini',
        why_not_selected:'No comparable feedback for this model; not selected merely for lower expense.'}]}),
      provider:name,model:p.modelId!};
  }} as LlmProvider));
  try{
    for(const mode of ['best_answer','best_value'] as const){
      const result=await runWithStandaloneAccounting(owner,()=>chooseProvider(original,
        'Earlier emotional discussion is background, not the new creative objective.',providers,
        {modelRegistrySnapshot:registry(),routing_mode:mode}));
      assert.equal(result.provider.name,'grok');
      assert.equal(result.modelId,'grok-4.3');
      assert.equal(result.resolvedIntent.decisionEvidence?.primary_objective,original);
    }
    assert.equal(selections,2,'one evidence-informed selection per route; no extra decision stage');
  }finally{rank.mock.restore();evidence.mock.restore();}
});
