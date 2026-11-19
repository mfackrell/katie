import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import * as admin from '@/lib/data/supabase/admin';
import * as economics from '@/lib/router/control-plane-economics';
import * as evidence from '@/lib/router/observed-evidence';
import {runWithStandaloneAccounting} from '@/lib/standalone-accounting/context';
import {
  classifyCurrentTurnFeedback, deriveCurrentTurnFeedbackProvenance,
  type CurrentTurnFeedbackProvenanceV1,
} from '@/lib/router/current-turn-feedback';
import {chooseProvider} from '@/lib/router/master-router';
import {chooseRoutingWithLLM} from '@/lib/router/model-intent';
import type {LlmProvider} from '@/lib/providers/types';
import type {RegistryRoutingModel} from '@/lib/models/registry';

const owner={userId:'owner-a',actorId:'actor-a',chatId:'chat-a',requestId:'request-a'};
const feedbackRequest={
  version:'current-turn-feedback-v1',
  source:{requestId:owner.requestId,userMessageId:null,
    textExcerpt:'Katie, that was terrible. You repeated yourself and failed to take initiative.',
    polarity:'negative',dimension:'continuity',correctionExcerpt:'Katie, that was terrible. You repeated yourself and failed to take initiative.'},
  target:{status:'attributed',assistantMessageId:'assistant-previous',priorRequestId:'req-previous',
    provider:'openai',model:'gpt-5-mini',priorIntent:'social-emotional',
    basis:'settled_scoped_saved_reply'},
  applicableToOngoingObjective:null,
} as const satisfies CurrentTurnFeedbackProvenanceV1;

test('current-turn feedback distinguishes praise, criticism, mixed feedback and unrelated text',()=>{
  assert.equal(classifyCurrentTurnFeedback('Katie, that is terrible. You repeated yourself and failed to take initiative.').polarity,'negative');
  assert.equal(classifyCurrentTurnFeedback('That was much better. Keep leading.').polarity,'positive');
  assert.equal(classifyCurrentTurnFeedback('That was better but you repeated the same mistake.').polarity,'ambiguous');
  assert.equal(classifyCurrentTurnFeedback('Continue the conversation without menus.').polarity,'none');
});

function fakeDatabase(options?:{lastRole?:string;priorStatus?:string;priorActor?:string;currentExists?:boolean; priorCompletedAt?:string|null; savedModel?:string; requestModel?:string; auditModel?:string}){
  const rows:Record<string,unknown>={
    standalone_workflows:{created_at:'2026-11-18T22:10:00.000Z'},
    chat_requests:{request_id:'req-previous',assistant_message_id:'assistant-previous',assistant_model:options?.requestModel??'gpt-5-mini',completed_at:options?.priorCompletedAt===undefined?'2026-11-18T22:09:59.000Z':options.priorCompletedAt}
  };
  const seen:Array<{table:string;eq:Array<[string,unknown]>;lt:Array<[string,unknown]>}>=[];
  const db={from:(table:string)=>{
    const state={table,eq:[] as Array<[string,unknown]>,lt:[] as Array<[string,unknown]>};
    seen.push(state);
    const query={
      select:()=>query,eq:(key:string,val:unknown)=>{state.eq.push([key,val]);return query;},
      lt:(key:string,val:unknown)=>{state.lt.push([key,val]);return query;},
      order:()=>query,
      limit:async()=>({data:table==='messages'?[{id:'assistant-previous',role:options?.lastRole??'assistant',model:options?.savedModel??'gpt-5-mini'}]:[],error:null}),
      maybeSingle:async()=>({data:table==='standalone_workflows'
        ? state.eq.some(([key,val])=>key==='request_id'&&val==='req-previous')
          ? {status:'completed',checkpoints:{'routing-delivery-audit:v1':{provider:'openai',model:options?.auditModel??'gpt-5-mini',classifiedIntent:'social-emotional'}}}
          : options?.currentExists===false?null:rows.standalone_workflows
        : table==='chat_requests' && options?.priorStatus==='failed'?null:rows[table]??null,error:null}),
    };
    return query;
  }};
  return {db,seen};
}

test('source-bound correction attaches only to a prior settled same-scope assistant',async()=>{
  const {db,seen}=fakeDatabase();
  const q=mock.method(admin,'getSupabaseAdminClient',()=>db as unknown as ReturnType<typeof admin.getSupabaseAdminClient>);
  try{
    const feedback=await runWithStandaloneAccounting(owner,()=>deriveCurrentTurnFeedbackProvenance({
      message:feedbackRequest.source.textExcerpt,
    }));
    assert.equal(feedback?.source.polarity,'negative');
    assert.equal(feedback?.source.userMessageId,null);
    assert.deepEqual(feedback?.target,{status:'attributed',assistantMessageId:'assistant-previous',
      priorRequestId:'req-previous',provider:'openai',model:'gpt-5-mini',
      priorIntent:'social-emotional',basis:'settled_scoped_saved_reply'});
    assert.equal(feedback?.applicableToOngoingObjective,null,'A must not invent ongoing-objective authority');
    assert.ok(seen.every(x=>x.eq.some(([key,val])=>key==='actor_id'&&val===owner.actorId) &&
      x.eq.some(([key,val])=>key==='chat_id'&&val===owner.chatId)));
    assert.ok(seen.filter(x=>x.table==='standalone_workflows').every(x=>
      x.eq.some(([key,val])=>key==='owner_id'&&val===owner.userId)));
    assert.deepEqual(seen.find(x=>x.table==='messages')?.lt,[['created_at','2026-11-18T22:10:00.000Z']]);
    assert.ok(!JSON.stringify(feedback).includes('next-selected-model'));
  }finally{q.mock.restore();}
});

test('prior user turn or unverified prior assistant cannot become an invented feedback target',async()=>{
  for(const opts of [{lastRole:'user'},{priorStatus:'failed'},{currentExists:false}]){
    const {db}=fakeDatabase(opts);
    const q=mock.method(admin,'getSupabaseAdminClient',()=>db as unknown as ReturnType<typeof admin.getSupabaseAdminClient>);
    try{
      const result=await runWithStandaloneAccounting(owner,()=>deriveCurrentTurnFeedbackProvenance({message:'Katie, that was terrible.'}));
      assert.equal(result?.target.status,'unattributed');
    }finally{q.mock.restore();}
  }
  assert.equal(await deriveCurrentTurnFeedbackProvenance({message:'That was great.'}),null);
});

test('feedback provenance rejects late completion and mismatched saved/delivery models',async()=>{
  const invalid=[
    {priorCompletedAt:'2026-11-18T22:10:01.000Z'}, // response completed after current request began
    {priorCompletedAt:null},                       // cannot establish settled ordering
    {savedModel:'gpt-5.4'},                        // saved assistant disagrees with receipt
    {requestModel:'gpt-5.4'},                      // completed request disagrees with audit
    {auditModel:'gpt-5.4'},                        // audit disagrees with saved reply
  ];
  for(const opts of invalid){
    const {db}=fakeDatabase(opts);
    const q=mock.method(admin,'getSupabaseAdminClient',()=>db as unknown as ReturnType<typeof admin.getSupabaseAdminClient>);
    try{
      const feedback=await runWithStandaloneAccounting(owner,()=>deriveCurrentTurnFeedbackProvenance({
        message:'Katie, that was terrible. You repeated yourself and failed to take initiative.'
      }));
      assert.equal(feedback?.target.status,'unattributed',JSON.stringify(opts));
      assert.equal(feedback?.target.status==='unattributed' ? feedback.target.reason : '',
        'missing_receipt',JSON.stringify(opts));
    }finally{q.mock.restore();}
  }
});

test('Best Value consumes current negative feedback only for the producing model',async()=>{
  const m=mock.method(admin,'getSupabaseAdminClient',()=>({rpc:async(name:string)=>{
    if(name==='standalone_routing_observations')
      return {data:{observations:[],overhead_micro_usd:null,quality_feedback:[]},error:null};
    if(name==='standalone_best_value_quality_feedback')return {data:[],error:null};
    throw Error('unexpected RPC');
  }} as unknown as ReturnType<typeof admin.getSupabaseAdminClient>));
  const providers:LlmProvider[]=[{name:'openai',listModels:async()=>['gpt-5-mini','gpt-5.4'],generate:async()=>{
    throw Error('No inference permitted');
  }} as LlmProvider];
  try{
    const candidates=[
      {providerName:'openai',modelId:'gpt-5-mini'},
      {providerName:'openai',modelId:'gpt-5.4'},
    ] as Parameters<typeof evidence.resolveRoutingEvidence>[0];
    const outcome=await runWithStandaloneAccounting(owner,()=>evidence.resolveRoutingEvidence(
      candidates,providers,undefined,'assistant-reflection',true,feedbackRequest));
    const negative=outcome.candidates['openai:gpt-5-mini'].quality.feedback?.potentially_comparable;
    assert.equal(negative?.[0]?.outcome,'negative');
    assert.equal(negative?.[0]?.source_id,'current-request:request-a');
    assert.equal(negative?.[0]?.source_intent,'social-emotional');
    assert.equal(outcome.candidates['openai:gpt-5.4'].quality.feedback,undefined);
  }finally{m.mock.restore();}
});

function registeredModels():Map<LlmProvider['name'],RegistryRoutingModel[]>{
  return new Map([['openai',['gpt-5-mini','gpt-5.4'].map(id=>({
    provider_name:'openai',model_id:id,routing_eligibility:'verified',
    capability_status:'verified',pricing_status:'verified',supports_text:true,
    supports_vision:false,supports_video:false,supports_image_generation:false,supports_web_search:false,
    reasoning_tier:'high',speed_tier:'medium',cost_tier:'medium',confidence_score:1,confidence_tier:'high',
  } as RegistryRoutingModel))]]);
}

test('Best Value rejects other-model feedback and bounds repeated invalid selections',async()=>{
  const rank=mock.method(economics,'rankControlPlaneByActualCost',async(candidates:unknown[])=>candidates);
  const quote=mock.method(evidence,'resolveRoutingEvidence',async(candidates:Parameters<typeof evidence.resolveRoutingEvidence>[0])=>
    ({overhead:{status:'unknown'},candidates:Object.fromEntries(candidates.map(x=>
      [`${x.providerName}:${x.modelId}`,{
        quality:x.modelId==='gpt-5.4'
          ? {status:'observed',observations:[],feedback:{
            positive:1,negative:0,ambiguous:0,
            evidence:[{source:'message_reaction',source_id:'praise-for-other-model',
              observed_at:new Date().toISOString(),outcome:'positive',dimension:'user_satisfaction',
              confidence:'direct_response_reaction',task_excerpt:'Prior unrelated task'}],
            uncertainty:'limited'
          }}:{status:'unknown',observations:[]},
        economics:{status:'unknown'}
      }])),
    }) as Awaited<ReturnType<typeof evidence.resolveRoutingEvidence>>);
  let reranks=0;
  let returnedDecisionJson=0;
  const provider:LlmProvider={name:'openai',listModels:async()=>['gpt-5-mini','gpt-5.4'],
    generate:async p=>{
      if(p.user.includes('CURRENT_USER_MESSAGE:'))return {
        text:JSON.stringify({intent:'social-emotional',complexity:'high',
          response_purpose:'conversation',provider_refusal_risk:'low',
          quality_requirements:'Distinctive voice, initiative, continuity.',
          primary_objective:'Continue conversation',objective_evidence:['Continue conversation'],
          context_influence:'Relevant prior context',selection_justification:'Quality objective recognized'}),
        provider:'openai',model:p.modelId!};
      reranks++;
      assert.match(p.user,/"routing_mode":"best_value"/,'prompt contains the actual mode JSON');
      assert.match(p.user,/"candidates":\[/,'prompt contains a real candidate list');
      returnedDecisionJson++;
      return {text:JSON.stringify({
        selected:{provider:'openai',model:'gpt-5-mini'},
        selection_justification:'Claims another model\'s satisfaction as direct evidence',
        quality_qualification:{required_quality:'Maintain continuity',
          selected_fit:'General capability',evidence_basis_kind:'attributed_feedback',
          evidence_basis:'User praised other model, source praise-for-other-model',
          comparative_uncertainty:'Comparative quality uncertain',
          cost_after_qualification:'Low cost'},
        alternatives:[{provider:'openai',model:'gpt-5.4',
          why_not_selected:'Higher price and uncertain quality difference'}]
      }),provider:'openai',model:p.modelId!};
    }};
  try{
    const result=await runWithStandaloneAccounting(owner,()=>chooseProvider(
      'Continue conversation','Previous conversation was creative',[provider],
      {modelRegistrySnapshot:registeredModels(),routing_mode:'best_value'}));
    assert.equal(reranks,3,'one initial, one correction, and one alternate; no unlimited cycling');
    assert.equal(returnedDecisionJson,3,'actual decision JSON must be returned; mock exceptions are not validation evidence');
    assert.equal(result.explainer?.selected_source,'deterministic-fallback');
  }finally{rank.mock.restore();quote.mock.restore();}
});


/**
 * Independent-A-QA acceptance paths: exercise the actual decision JSON parser,
 * not an exception thrown by a fake provider before a selection is returned.
 * No network, paid inference, or production database access is performed.
 */
type FeedbackOutcome = 'positive' | 'negative' | 'ambiguous';
function bestValueSourceEvidence(selectedOutcome: FeedbackOutcome | null = null,
                                 otherOutcome: FeedbackOutcome | null = null) {
  const feedback = (outcome: FeedbackOutcome, sourceId: string) => ({
    positive: Number(outcome === 'positive'), negative: Number(outcome === 'negative'),
    ambiguous: Number(outcome === 'ambiguous'), uncertainty:'One scoped, explicit user feedback event',
    evidence:[{source:'message_reaction',source_id:sourceId,observed_at:'2026-11-18T22:00:00.000Z',
      dimension:'user_satisfaction',outcome,confidence:'direct_response_reaction',
      task_excerpt:'Creative conversational continuation'}]
  });
  return {overhead:{status:'unknown'},candidates:{
    'openai:gpt-5-mini':{quality:{status:'unknown',observations:[],
      ...(selectedOutcome?{feedback:feedback(selectedOutcome,'source-mini')}: {})},economics:{status:'unknown'}},
    'openai:gpt-5.4':{quality:{status:'unknown',observations:[],
      ...(otherOutcome?{feedback:feedback(otherOutcome,'source-other')}: {})},economics:{status:'unknown'}}
  }};
}
function selectionJson(selectedModel: string, evidenceBasis: string,
                       kind = 'attributed_feedback') {
  const alternative = selectedModel === 'gpt-5-mini' ? 'gpt-5.4' : 'gpt-5-mini';
  return JSON.stringify({
    selected:{provider:'openai',model:selectedModel},
    selection_justification:'Selected on task-specific quality with documented limitations.',
    quality_qualification:{
      required_quality:'Creative conversational continuity and initiative.',
      selected_fit:'Can provide a direct, coherent response.',
      evidence_basis_kind:kind,evidence_basis:evidenceBasis,
      comparative_uncertainty:'Actual comparative quality remains uncertain.',
      cost_after_qualification:'Lower quoted cost only after quality qualification.'
    },
    alternatives:[{provider:'openai',model:alternative,
      why_not_selected:'Less certain task quality or higher expected price.'}]
  });
}
async function executeSelectionCase(responses: string[], evidenceData = bestValueSourceEvidence()) {
  const rank=mock.method(economics,'rankControlPlaneByActualCost',async(candidates:unknown[])=>candidates);
  const returned:Array<{modelId:string;corrected:boolean;text:string}>=[];
  let attempt=0;
  const provider:LlmProvider={
    name:'openai',listModels:async()=>['gpt-5-mini','gpt-5.4'],
    generate:async params=>{
      const text=responses[Math.min(attempt,responses.length-1)];
      returned.push({modelId:params.modelId??'',corrected:params.user.includes('CORRECTION:'),
        text});
      attempt++;
      return {text,provider:'openai',model:params.modelId!};
    }
  };
  try{
    const decisionProviders=[
      {provider,modelId:'gpt-5-mini'},
      {provider,modelId:'gpt-5.4'}
    ];
    const candidates=['gpt-5-mini','gpt-5.4'].map(modelId=>({
      providerName:'openai',modelId,supports_text:true,
      supports_vision:false,supports_video:false,supports_image_generation:false,
      supports_web_search:false,reasoning_depth_tier:'high',speed_tier:'medium',
      cost_tier:'medium',specialization_tags:[],prior_score:1,score_breakdown:{}
    }));
    const result=await runWithStandaloneAccounting(owner,()=>chooseRoutingWithLLM({
      routing_mode:'best_value',prompt:'Continue our creative conversation with initiative.',
      intent:'assistant-reflection',modalityFlags:{has_images:false,has_video_input:false},
      hardRouteContext:{hard_rule_applied:false,rule:'none'},preferenceProfile:{},
      candidates,decisionProviders,registryLookup:new Map(
        (registeredModels().get('openai')??[]).map(item=>['openai:'+item.model_id,item])),
      requestEvidence:evidenceData
    } as unknown as Parameters<typeof chooseRoutingWithLLM>[0]));
    assert.equal(returned.length,attempt,'each attempted model must return its mocked JSON');
    assert.ok(returned.every(x=>typeof x.text==='string'),
      'all test provider attempts must actually produce their promised payload');
    return {result,returned};
  }finally{rank.mock.restore();}
}

test('A-QA1 wrong-model praise is rejected, and a corrected documented selection is accepted',async()=>{
  const wrong=selectionJson('gpt-5-mini','User praised source-other','attributed_feedback');
  const corrected=selectionJson('gpt-5-mini','Documented text support; comparative outcomes unverified.',
    'documented_capability');
  const {result,returned}=await executeSelectionCase([wrong,corrected],
    bestValueSourceEvidence(null,'positive'));
  assert.equal(returned.length,2,'actual rejected JSON must trigger exactly one correction');
  assert.equal(returned[0].text,wrong,'the original wrong-source selection reached the parser');
  assert.equal(returned[1].corrected,true,'second request carried correction instructions');
  assert.equal(result.accepted,true,'valid documented-capability correction must be accepted');
  assert.equal(result.accepted ? result.selected.modelId : null,'gpt-5-mini');
});

test('A-QA1 same-model negative and ambiguous evidence cannot be described as praise',async()=>{
  for(const polarity of ['negative','ambiguous'] as const){
    const falsePraise=selectionJson('gpt-5-mini','User praised model; source-mini');
    const honest=selectionJson('gpt-5-mini',
      polarity==='negative' ? 'User criticized model; source-mini' :
        'Mixed response, ambiguous outcome; source-mini');
    const {result,returned}=await executeSelectionCase([falsePraise,honest],
      bestValueSourceEvidence(polarity));
    assert.equal(returned.length,2,polarity+' false praise must be rejected');
    assert.equal(returned[1].corrected,true);
    assert.equal(result.accepted,true,polarity+' with honest attribution is valid');
  }
});

test('A-QA1 true selected-model positive evidence can qualify a cited selection',async()=>{
  const truePraise=selectionJson('gpt-5-mini','User praised model; source-mini');
  const {result,returned}=await executeSelectionCase([truePraise],
    bestValueSourceEvidence('positive'));
  assert.equal(returned.length,1,'source-cited direct positive must pass first attempt');
  assert.equal(result.accepted,true);
});

test('A-QA1 actual invalid JSON is bounded to 3 decisions with one correction',async()=>{
  const {result,returned}=await executeSelectionCase(['{not-json']);
  assert.equal(result.accepted,false);
  if(result.accepted) assert.fail('An invalid selection must fail closed');
  assert.equal(result.reason,'all_decision_providers_failed');
  assert.equal(returned.length,3,'initial, one retry, and one alternate only');
  assert.deepEqual(returned.map(x=>x.modelId),['gpt-5-mini','gpt-5-mini','gpt-5.4']);
  assert.deepEqual(returned.map(x=>x.corrected),[false,true,true]);
});

test('A-QA1 actual JSON with an ineligible provider:model pair is bounded to 3',async()=>{
  const invalid=selectionJson('nonexistent-model','Documented support','documented_capability');
  const {result,returned}=await executeSelectionCase([invalid]);
  assert.equal(result.accepted,false);
  if(result.accepted) assert.fail('An invalid selection must fail closed');
  assert.equal(result.reason,'all_decision_providers_failed');
  assert.equal(returned.length,3);
  assert.ok(returned.every(x=>x.text===invalid),'valid JSON with invalid model was returned');
  assert.deepEqual(returned.map(x=>x.modelId),['gpt-5-mini','gpt-5-mini','gpt-5.4']);
});


test('A-QA3 fabricated praise cannot be laundered as documented capability evidence',async()=>{
  const forged=selectionJson('gpt-5-mini',
    'User praised gpt-5-mini based on source-other','documented_capability');
  const {result,returned}=await executeSelectionCase([forged],
    bestValueSourceEvidence(null,'positive'));
  assert.equal(returned[0]?.text,forged,'actual forged decision JSON must reach the parser');
  assert.equal(returned.length,3,'false attribution must be rejected at each bounded attempt');
  assert.equal(result.accepted,false,'another model\'s positive event is not selected-model documentation');
});

test('A-QA3 fabricated satisfaction in selection justification is rejected even with innocent evidence basis',async()=>{
  const parsed=JSON.parse(selectionJson('gpt-5-mini',
    'Documented text capability only; outcome quality unverified.','documented_capability'));
  parsed.selection_justification='User praised gpt-5-mini based on source-other.';
  const forged=JSON.stringify(parsed);
  const {result,returned}=await executeSelectionCase([forged],
    bestValueSourceEvidence(null,'positive'));
  assert.equal(returned[0]?.text,forged);
  assert.equal(returned.length,3,'justification-only fabrication must be checked too');
  assert.equal(result.accepted,false);
});

test('A-QA3 explicit negative or mixed user reactions cannot be relabeled as model documentation',async()=>{
  for(const claim of ['Negative user feedback based on source-other.',
    'Mixed user feedback based on source-other.']){
    const forged=selectionJson('gpt-5-mini',claim,'documented_capability');
    const {result,returned}=await executeSelectionCase([forged],
      bestValueSourceEvidence(null,'negative'));
    assert.equal(returned[0]?.text,forged);
    assert.equal(result.accepted,false,claim);
  }
});

test('A-QA3 honest documented capability and explicit absence of feedback remain valid',async()=>{
  for(const statement of ['Documented text support; comparative quality unverified.',
    'No user praise has been recorded; only text capability is documented.']){
    const honest=selectionJson('gpt-5-mini',statement,'documented_capability');
    const {result,returned}=await executeSelectionCase([honest],
      bestValueSourceEvidence(null,'positive'));
    assert.equal(returned.length,1,statement);
    assert.equal(result.accepted,true,statement);
  }
});

test('A-QA3 foreign-source praise in justification cannot contaminate a genuinely positive selected-model event',async()=>{
  const parsed=JSON.parse(selectionJson('gpt-5-mini',
    'User praised selected model; source-mini','attributed_feedback'));
  parsed.selection_justification='User praised gpt-5.4 according to source-other.';
  const forged=JSON.stringify(parsed);
  const {result,returned}=await executeSelectionCase([forged],
    bestValueSourceEvidence('positive','positive'));
  assert.equal(returned[0]?.text,forged);
  assert.equal(result.accepted,false,'another candidate\'s event is not a citation for the selected model');
});


test('A-QA3 cited negative or ambiguous events cannot become praise in justification',async()=>{
  for(const polarity of ['negative','ambiguous'] as const){
    const parsed=JSON.parse(selectionJson('gpt-5-mini',
      polarity==='negative' ? 'User criticized model; source-mini' :
        'Mixed response, ambiguous outcome; source-mini','attributed_feedback'));
    parsed.selection_justification='User praised gpt-5-mini and was satisfied with it.';
    const forged=JSON.stringify(parsed);
    const {result,returned}=await executeSelectionCase([forged],
      bestValueSourceEvidence(polarity));
    assert.equal(returned[0]?.text,forged);
    assert.equal(result.accepted,false,polarity+' cannot support a claimed positive judgment');
  }
});

test('A-QA3 relabeled user praise in selected-fit field is rejected',async()=>{
  const parsed=JSON.parse(selectionJson('gpt-5-mini',
    'Documented text capability only.','documented_capability'));
  parsed.quality_qualification.selected_fit='User praised gpt-5-mini from source-other.';
  const forged=JSON.stringify(parsed);
  const {result,returned}=await executeSelectionCase([forged],
    bestValueSourceEvidence(null,'positive'));
  assert.equal(returned[0]?.text,forged);
  assert.equal(result.accepted,false);
});


test('A-QA3 wording variants cannot launder unsourced user praise through capability labels',async()=>{
  const claims=[
    'User feedback was positive for gpt-5-mini',
    'The user expressed satisfaction with gpt-5-mini',
    'The previous completion earned explicit praise from the user',
  ];
  for(const claim of claims){
    for(const field of ['evidence_basis','selection_justification','selected_fit'] as const){
      const parsed=JSON.parse(selectionJson('gpt-5-mini',
        'Documented text support; no verified outcome.','documented_capability'));
      if(field==='selection_justification') parsed.selection_justification=claim;
      else parsed.quality_qualification[field]=claim;
      const forged=JSON.stringify(parsed);
      const {result,returned}=await executeSelectionCase([forged],
        bestValueSourceEvidence(null,'positive'));
      assert.equal(returned[0]?.text,forged,
        field+' must return actual JSON for: '+claim);
      assert.equal(returned.length,3,
        field+' must reject on all bounded parser attempts: '+claim);
      assert.equal(result.accepted,false,
        field+' cannot claim other-model praise: '+claim);
    }
  }
});

test('A-QA3 feedback wording and polarity must match the selected model, including justification',async()=>{
  const source=bestValueSourceEvidence('negative');
  const parsed=JSON.parse(selectionJson('gpt-5-mini',
    'User criticized selected model; source-mini','attributed_feedback'));
  parsed.selection_justification='User feedback was positive for gpt-5-mini';
  const falsePositive=JSON.stringify(parsed);
  const rejected=await executeSelectionCase([falsePositive],source);
  assert.equal(rejected.returned[0]?.text,falsePositive);
  assert.equal(rejected.result.accepted,false,
    'negative direct feedback cannot justify positive claims under a different word order');
  assert.equal(rejected.returned.length,3);

  const honest=selectionJson('gpt-5-mini',
    'User feedback was negative for gpt-5-mini; source-mini','attributed_feedback');
  const accepted=await executeSelectionCase([honest],source);
  assert.equal(accepted.returned.length,1);
  assert.equal(accepted.result.accepted,true,
    'honest cited negative feedback should remain eligible for comparison');
});
