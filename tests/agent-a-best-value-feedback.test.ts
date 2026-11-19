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
      const payload=JSON.parse(p.user.slice(p.user.lastIndexOf('\n\n')+2));
      assert.equal(payload.routing_mode,'best_value');
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
    assert.equal(result.explainer?.selected_source,'deterministic-fallback');
  }finally{rank.mock.restore();quote.mock.restore();}
});
