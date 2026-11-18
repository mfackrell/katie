import test, {mock} from 'node:test';
import * as admin from '@/lib/data/supabase/admin';
import assert from 'node:assert/strict';
import { OpenAiProvider } from '@/lib/providers/openai-provider';
import { ClaudeProvider } from '@/lib/providers/claude-provider';
import { quoteSerializedRoutingRequest } from '@/lib/router/control-plane-economics';
import { resolveRoutingEvidence, expectedCost, qualityFromObservations, modelAttributedFeedback, type ObservedRoutingRow, type ObservedModelFeedback } from '@/lib/router/observed-evidence';
import { getAccountingScope, runWithStandaloneAccounting } from '@/lib/standalone-accounting/context';
import { buildCandidateMetadata } from '@/lib/router/model-intent';
import { estimatePreparedRequest, prepareStandaloneRequest } from '@/lib/standalone-accounting/estimate';

const owner = {userId:'test-owner',actorId:'test-actor',chatId:'test-chat',requestId:'test-request'};
const tasks = [
  'Hello Katie', 'Reconcile debt covenants and write a board memo',
  'Implement idempotent payment recovery', 'Continue the poem in my voice',
  'Help me write an emotionally careful reply', 'Explain the screenshot',
];
for (const task of tasks) test(`native serialized pricing includes full request without paid probes: ${task}`, async () => {
  const fetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {calls++; throw Error('No network in quotation tests');};
  try {
    await runWithStandaloneAccounting(owner, async () => {
      const params = {name:'Katie',persona:'Keep my actor voice. '.repeat(100), summary:'Earlier source evidence',
        history:[{role:'user' as const,content:'Retain these continuity details. '.repeat(100)}],user:task};
      const quotes = [];
      for (const [provider,model] of [[new OpenAiProvider('test-only-key'),'gpt-4o-mini'],[new ClaudeProvider('test-only-key'),'claude-sonnet-4-6']] as const) {
        const quote = await quoteSerializedRoutingRequest(provider,{...params,modelId:model});
        assert.ok(quote); assert.equal(quote.status,'estimated',JSON.stringify(quote.issues));
        assert.ok(quote.inputTokens > params.user.length + params.persona.length);
        assert.ok(quote.outputAllowance > 1024);
        assert.match(quote.request_hash,/^[a-f0-9]{64}$/);
        assert.ok(BigInt(quote.estimatedCostMicrousd!) > 0n);
        const changed = await quoteSerializedRoutingRequest(provider,{...params,modelId:model,summary:'different memory'});
        assert.notEqual(changed?.request_hash,quote.request_hash);
        quotes.push(quote);
      }
      assert.notEqual(quotes[0].estimatedCostMicrousd,quotes[1].estimatedCostMicrousd);
      const scope = getAccountingScope();
      assert.equal(scope?.kind === 'standalone' ? scope.counter.size : -1,0);
    });
    assert.equal(calls,0,'quotation must stop before every provider transmission');
  } finally {globalThis.fetch=fetch;}
});
const row = (provider='openai',model='gpt-4o-mini', overrides: Partial<ObservedRoutingRow> = {}): ObservedRoutingRow => ({
  request_id:'prior-delivery',observed_at:new Date().toISOString(),provider,model,intent:'rewrite',status:'pass',
  reason:'explicit_output_present',output_tokens:50,cache_hit_tokens:0,attempts:1,...overrides,
});
test('quality observations retain provenance, recency, sample count and limits; missing evidence is unknown', () => {
  const rows = [row(), row('openai','gpt-4o-mini',{request_id:'failed-delivery',status:'fail'}),
    row('openai','gpt-4o-mini',{intent:'code-generation'}),
    row('openai','gpt-4o-mini',{observed_at:'2020-01-01T00:00:00Z'}),
    row('openai','gpt-4o-mini',{observed_at:'2099-01-01T00:00:00Z'})];
  const known = qualityFromObservations(rows,'openai','gpt-4o-mini','rewrite');
  assert.equal(known.observations[0].sample_count,2);
  assert.equal(known.observations[0].passes,1); assert.equal(known.observations[0].failures,1);
  assert.deepEqual(known.observations[0].provenance,['prior-delivery','failed-delivery']);
  assert.match(known.observations[0].uncertainty,/no correctness/);
  assert.deepEqual(qualityFromObservations(rows,'anthropic','claude-sonnet-4-6','rewrite'),{status:'unknown',observations:[]});
  assert.doesNotMatch(JSON.stringify(known),/quality_score|ranking/);
});

test('model-attributed user feedback retains task, provenance, exact source and uncertainty without scores', () => {
  const observed_at = new Date().toISOString();
  const source = (provider:string, model:string, intent:string, outcome:'positive'|'negative'|'ambiguous',
    overrides:Partial<ObservedModelFeedback>={}):ObservedModelFeedback => ({
    request_id:'prior-1', observed_at, provider, model, intent, outcome,
    source:'adjacent_user_feedback',dimension:'objective_fidelity',
    confidence:'context_attributed_not_verified',source_id:'user-msg-1',
    task_excerpt:'An existing finance or creative task',...overrides
  });
  const rows = [
    source('openai','gpt-5-mini-2025-08-07','social-emotional','negative'),
    source('anthropic','claude-sonnet-5-5','social-emotional','positive',
      {source:'message_reaction',dimension:'user_satisfaction',confidence:'direct_response_reaction'}),
    source('openai','gpt-5-mini-2025-08-07','code-generation','positive'),
    source('openai','gpt-5-mini-2025-08-07','social-emotional','positive',
      {observed_at:'2020-01-01T00:00:00Z'}),
  ];
  const poor = modelAttributedFeedback(rows,'openai','gpt-5-mini','social-emotional');
  assert.equal(poor?.negative,1);
  assert.equal(poor?.positive,0);
  assert.equal(poor?.evidence[0].source_id,'user-msg-1');
  assert.match(poor?.uncertainty??'',/No evidence implies global model superiority/i);
  assert.equal(modelAttributedFeedback(rows,'anthropic','claude-sonnet-5-5','social-emotional')?.positive,1);
  assert.equal(modelAttributedFeedback(rows,'openai','gpt-5-mini','rewrite'),undefined);
  const bestValueOnly = modelAttributedFeedback(rows,'openai','gpt-5-mini','general-text',Date.now(),true);
  assert.equal(bestValueOnly?.negative,1,'comparable conversation feedback survives label changes');
  assert.equal(bestValueOnly?.positive,0,'unrelated code-generation feedback must not contaminate conversation');
  assert.equal(bestValueOnly?.evidence[0].source_intent,'social-emotional');
  assert.equal(modelAttributedFeedback(rows,'openai','gpt-5-mini','general-text'),undefined,
    'Best Answer retains exact-intent behavior');
  assert.equal(modelAttributedFeedback(rows,'openai','gpt-4o-mini','social-emotional'),undefined);
  assert.doesNotMatch(JSON.stringify(poor),/quality_score|provider_rank|preferred_provider/);
});

test('Best Value reads additional attributed feedback; Best Answer invokes only the original RPC',async()=>{
  const calls: string[] = [];
  const db = mock.method(admin,'getSupabaseAdminClient',() => ({rpc:async(name:string)=>{
    calls.push(name);
    if(name==='standalone_routing_observations')
      return {data:{observations:[],overhead_micro_usd:null,quality_feedback:[]},error:null};
    if(name==='standalone_best_value_quality_feedback')
      return {data:[{request_id:'old-conversation',observed_at:new Date().toISOString(),
        provider:'openai',model:'gpt-5-mini-2025-08-07',intent:'social-emotional',
        source:'adjacent_user_feedback',dimension:'objective_fidelity',outcome:'negative',
        confidence:'explicit_next_turn_comment_context_attributed',
        source_id:'user-message',task_excerpt:'Continue the creative conversation in my voice'}],error:null};
    throw Error('Unexpected evidence RPC');
  }} as unknown as ReturnType<typeof admin.getSupabaseAdminClient>));
  try {
    const params = {name:'Katie',persona:'existing voice',summary:'',history:[],user:'Keep the conversation going'};
    const candidates=[buildCandidateMetadata('openai','gpt-5-mini','general-text')];
    const providers=[new OpenAiProvider('test-only')];
    const answer=await runWithStandaloneAccounting(owner,()=>resolveRoutingEvidence(
      candidates,providers,params,'general-text',false));
    assert.deepEqual(calls,['standalone_routing_observations']);
    assert.equal(answer.candidates['openai:gpt-5-mini'].quality.feedback,undefined);
    calls.length=0;
    const value=await runWithStandaloneAccounting(owner,()=>resolveRoutingEvidence(
      candidates,providers,params,'general-text',true));
    assert.deepEqual(calls,['standalone_routing_observations','standalone_best_value_quality_feedback']);
    const feedback=value.candidates['openai:gpt-5-mini'].quality.feedback;
    assert.equal(feedback?.negative,1);
    assert.equal(feedback?.evidence[0].source_intent,'social-emotional');
    assert.match(feedback?.evidence[0].task_excerpt??'',/creative conversation/);
  } finally {db.mock.restore();}
});

function quote(model: string, media = false, textLength = 10000) {
  // Immutable PNG header with known 512x512 dimensions; no URL is fetched.
  const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(512,16);png.writeUInt32BE(512,20);
  const prepared = prepareStandaloneRequest('openai',model,'/v1/chat/completions',{model,max_tokens:1,
    messages:[{role:'user',content: media ? [{type:'text',text:'a'.repeat(textLength)},
      {type:'image_url',image_url:{url:'data:image/png;base64,'+png.toString('base64'),detail:'high'}}] : 'a'.repeat(textLength)}]});
  return {request_hash:prepared.hash,endpoint:prepared.endpoint,...estimatePreparedRequest(prepared)};
}
const cost = (model:string, rows:ObservedRoutingRow[], media=false) => expectedCost('openai',model,quote(model,media),rows,'123');
const value = (c:ReturnType<typeof cost>) => BigInt(c.expected_generation_plus_observed_overhead_micro_usd!);
test('reviewed candidate prices change the cost winner with observed retries and cache hits', () => {
  const mini = row(), full = row('openai','gpt-4.1');
  assert.ok(value(cost(mini.model,[mini])) < value(cost(full.model,[full])));
  assert.ok(value(cost(mini.model,[{...mini,attempts:30}])) > value(cost(full.model,[full])));
  const expensive = cost('gpt-4.1',[full]);
  const cached = cost('gpt-4.1',[{...full,cache_hit_tokens:10000}]);
  assert.ok(value(cached) < value(expensive));
  assert.equal(cost(mini.model,[]).expected_generation_plus_observed_overhead_micro_usd,null);
  assert.equal(cost(mini.model,[mini]).expected_all_in_micro_usd,null,'without helper receipts total overhead is unknown');
  const allIn = cost(mini.model,[{...mini,overhead_micro_usd:'999'}]);
  assert.equal(value(allIn) + 876n, BigInt(allIn.expected_all_in_micro_usd!));
  assert.equal(allIn.overhead_sample_count,1);
});
test('native image token pricing can reverse a real priced model comparison', () => {
  const a = row(), b = row('openai','gpt-4.1');
  assert.ok(value(cost(a.model,[a])) < value(cost(b.model,[b])));
  // Small text contexts make the mini model visual tile tariff dominate.
  const mini = quote('gpt-4o-mini',true,1), full = quote('gpt-4.1',true,1);
  assert.equal(mini.status,'estimated'); assert.equal(full.status,'estimated');
  assert.ok(mini.imageTokens > full.imageTokens);
  assert.ok(BigInt(mini.estimatedCostMicrousd!) > BigInt(full.estimatedCostMicrousd!));
  assert.notEqual(mini.request_hash,quote('gpt-4o-mini').request_hash);
});
test('quotation outside standalone accounting never invokes a provider', async () => {
  const provider = new OpenAiProvider('test-only');
  provider.generate = async () => {throw Error('must not invoke');};
  assert.equal(await quoteSerializedRoutingRequest(provider,{name:'K',persona:'',summary:'',history:[],user:'Hi',modelId:'gpt-4o-mini'}),null);
});

test('runtime resolver uses admitted identity, observed task evidence and serialized candidate payloads', async () => {
  let rpcCalls = 0;
  const db = mock.method(admin,'getSupabaseAdminClient',() => ({rpc: async (name:string,args:Record<string,string>) => {
    rpcCalls++;
    assert.equal(name,'standalone_routing_observations');
    assert.deepEqual(args,{p_owner:owner.userId,p_actor:owner.actorId,p_chat:owner.chatId,p_request:owner.requestId,p_intent:'rewrite'});
    return {data:{observations:[row()],overhead_micro_usd:'123',quality_feedback:[{
      request_id:'user-feedback-1',observed_at:new Date().toISOString(),provider:'openai',model:'gpt-4o-mini',
      intent:'rewrite',source:'message_reaction',dimension:'user_satisfaction',outcome:'positive',
      confidence:'direct_response_reaction',source_id:'message-id-1',task_excerpt:'Rewrite this email'
    }]},error:null};
  }} as unknown as ReturnType<typeof admin.getSupabaseAdminClient>));
  try {
    const provider = new OpenAiProvider('test-only');
    const result = await runWithStandaloneAccounting(owner,() => resolveRoutingEvidence([
      buildCandidateMetadata('openai','gpt-4o-mini','rewrite'),buildCandidateMetadata('openai','gpt-4.1','rewrite'),
    ],[provider],{name:'Katie',persona:'actor persona',summary:'memory',history:[],user:'Rewrite this'},'rewrite'));
    assert.equal(rpcCalls,1);
    assert.equal(result.candidates['openai:gpt-4o-mini'].quality.observations[0].sample_count,1);
    assert.equal(result.candidates['openai:gpt-4o-mini'].quality.feedback?.positive,1);
    assert.equal(result.candidates['openai:gpt-4o-mini'].quality.feedback?.evidence[0].source,'message_reaction');
    assert.deepEqual(result.candidates['openai:gpt-4.1'].quality,{status:'unknown',observations:[]});
    assert.match(JSON.stringify(result.candidates['openai:gpt-4o-mini'].economics),/serialized_request/);
    const before = rpcCalls;
    assert.deepEqual(await resolveRoutingEvidence([],[],undefined,'rewrite'),{overhead:{status:'unknown'},candidates:{}});
    assert.equal(rpcCalls,before,'orchestrator calls cannot read standalone evidence');
  } finally {db.mock.restore();}
});

test('unverified text quality still supplies trusted economic history', () => {
  const unverified = row('openai','gpt-4o-mini',{status:'unverified',overhead_micro_usd:'25'});
  assert.deepEqual(qualityFromObservations([unverified],unverified.provider,unverified.model,'rewrite'),
    {status:'unknown',observations:[]});
  const economic = cost(unverified.model,[unverified]);
  assert.equal(economic.sample_count,1);
  assert.equal(economic.expected_output_tokens,1); // This fixture quote has a one-token output ceiling.
  assert.equal(economic.expected_attempts,1);
  assert.match(economic.expected_all_in_micro_usd!,/^[0-9]+$/);
});
