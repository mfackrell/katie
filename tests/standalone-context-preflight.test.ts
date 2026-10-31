import test from 'node:test';
import assert from 'node:assert/strict';
import { countNativePreparedInput } from '../lib/standalone-accounting/native-token-count';
import { selectContextCapacityUpgrade } from '../lib/standalone-accounting/context-upgrade';
import { estimatePreparedRequest, freezePreparedRequest, PROVIDER_COUNT_ESTIMATOR_VERSION } from '../lib/standalone-accounting/estimate';
import { getModelPrice, PRICING_SNAPSHOT } from '../lib/standalone-accounting/pricing';
import { runWithRefusalFallback } from '../lib/router/refusal-detection';
import { standaloneTechnicalBlocker } from '../lib/standalone-accounting/context';

test('native Anthropic count uses unchanged frozen model/system/messages and never sends output allowance',async()=>{
  const prompt='Very large saved system prompt. '.repeat(10500);
  const prepared=freezePreparedRequest('anthropic','claude-sonnet-4-5','/v1/messages',{
    model:'claude-sonnet-4-5',max_tokens:16384,system:prompt,
    messages:[{role:'user',content:'hi katie'}],
  });
  const heuristic=estimatePreparedRequest(prepared);
  assert.equal(heuristic.status,'unsupported');
  assert.match(heuristic.issues.join(' '),/context window/);
  let calls=0;
  const count=await countNativePreparedInput(prepared,async(url,init)=>{
    calls++;assert.equal(String(url),'https://api.anthropic.com/v1/messages/count_tokens');
    const body=JSON.parse(String(init?.body));
    assert.deepEqual(body,{model:prepared.model,system:prompt,messages:prepared.payload.messages});
    assert.equal(init?.method,'POST');assert.equal(init?.redirect,'manual');
    assert.equal(new Headers(init?.headers).get('x-api-key'),'redacted-fixture');
    return Response.json({input_tokens:85000});
  },{'x-api-key':'redacted-fixture','anthropic-version':'2023-06-01'});
  assert.equal(calls,1);assert.equal(count,85000);
  const quoted=estimatePreparedRequest(prepared,PRICING_SNAPSHOT,{requestHash:prepared.hash,inputTokens:count!});
  assert.equal(quoted.status,'estimated');
  assert.equal(quoted.inputTokens,85000);
  assert.equal(quoted.outputAllowance,16384,'full unchanged generation allowance');
  assert.equal(quoted.inputCountSource,'provider');
  assert.equal(quoted.estimatorVersion,PROVIDER_COUNT_ESTIMATOR_VERSION);
  assert.ok(BigInt(quoted.reservationMicrousd!)<BigInt('1000000'));
  assert.equal(estimatePreparedRequest(prepared,PRICING_SNAPSHOT,{requestHash:'wrong',inputTokens:100}).status,'unsupported','token evidence is hash bound');
});

test('unsupported Sonnet 4.5 counting does not infer a count or dispatch paid messages',async()=>{
  const prepared=freezePreparedRequest('anthropic','claude-sonnet-4-5','/v1/messages',{model:'claude-sonnet-4-5',messages:[{role:'user',content:'hello'}],max_tokens:16384});
  let calls=0;
  const count=await countNativePreparedInput(prepared,async(_url,init)=>{
    calls++;
    assert.doesNotMatch(String(init?.body),/"max_tokens"/);
    return Response.json({error:{type:'invalid_request_error'}},{status:400});
  },{});
  assert.equal(calls,1);assert.equal(count,null);
  assert.equal(standaloneTechnicalBlocker('standalone_context_capacity_unverified'),true);
  assert.equal(standaloneTechnicalBlocker('standalone_approval_required'),false);
});

test('native OpenAI Responses and Gemini counts operate on input and reject malformed provider receipts',async()=>{
  const openai=freezePreparedRequest('openai','gpt-5','/v1/responses',{model:'gpt-5',input:[{role:'user',content:'hello'}],max_output_tokens:16384,stream:true});
  const counted=await countNativePreparedInput(openai,async(url,init)=>{
    assert.equal(String(url),'https://api.openai.com/v1/responses/input_tokens');
    const body=JSON.parse(String(init?.body));
    assert.deepEqual(body,{model:'gpt-5',input:openai.payload.input});
    return Response.json({object:'response.input_tokens',input_tokens:42});
  },{authorization:'Bearer test-secret'});
  assert.equal(counted,42);
  const google=freezePreparedRequest('google','gemini-2.5-pro','/v1beta/models/gemini-2.5-pro:generateContent',{
    contents:[{role:'user',parts:[{text:'hello'}]}],generationConfig:{maxOutputTokens:8192},
  });
  const geminiCount=await countNativePreparedInput(google,async(url,init)=>{
    assert.equal(String(url),'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:countTokens');
    assert.deepEqual(JSON.parse(String(init?.body)),{generateContentRequest:google.payload});
    return Response.json({totalTokens:71});
  },{});
  assert.equal(geminiCount,71);
  assert.equal(await countNativePreparedInput(openai,async()=>Response.json({input_tokens:'42'}),{}),null);
  assert.equal(await countNativePreparedInput(freezePreparedRequest('grok','grok-4.7','/v1/chat/completions',{model:'grok-4.7',messages:[],max_tokens:100}),async()=>{throw Error('must not call provider');},{}),null);
});

test('context upgrade requires a reviewed, fitting model without reducing capability',()=>{
  const old=getModelPrice('anthropic','claude-sonnet-4-5')!;
  const newPrice=getModelPrice('anthropic','claude-sonnet-4-6')!;
  const snapshot={...PRICING_SNAPSHOT,models:[...PRICING_SNAPSHOT.models,
    {...old,model:'claude-sonnet-4-5-20250929'},
    {...newPrice,model:'claude-sonnet-5'},
  ]};
  const options=['claude-haiku-5-5','claude-sonnet-4-5-20250929','claude-sonnet-4-6','claude-sonnet-5','claude-opus-4-6'];
  const base={provider:'anthropic' as const,model:'claude-sonnet-4-5-20250929',pricing:snapshot,inputTokens:190000,outputAllowance:16384};
  assert.equal(selectContextCapacityUpgrade({...base,availableModels:options}), 'claude-sonnet-5');
  assert.equal(selectContextCapacityUpgrade({...base,availableModels:options,excludedModels:new Set(['claude-sonnet-5'])}), 'claude-sonnet-4-6');
  assert.equal(selectContextCapacityUpgrade({...base,availableModels:options,outputAllowance:128001}), null);
  assert.equal(selectContextCapacityUpgrade({...base,availableModels:['claude-haiku-5-5','claude-opus-4-6']}),'claude-opus-4-6','a higher Anthropic tier is allowed');
  assert.equal(selectContextCapacityUpgrade({...base,availableModels:['claude-haiku-5-5']}),null,'never downgrade from Sonnet');
  assert.equal(selectContextCapacityUpgrade({...base,availableModels:options,inputTokens:1000000}),null,'verified context must fit the unchanged full input');
});

test('BTG resume context overflow promotes GPT-5.4 Mini to full GPT-5.4, without spending or truncation',()=>{
  // Dynamic catalog includes this Mini identity; the static fallback snapshot
  // deliberately does not. All candidates still require an exact reviewed row.
  const mini={...getModelPrice('openai','gpt-5-mini')!,model:'gpt-5.4-mini',maxContextTokens:128000};
  const snapshot={...PRICING_SNAPSHOT,models:[...PRICING_SNAPSHOT.models,mini]};
  const base={provider:'openai' as const,model:'gpt-5.4-mini',pricing:snapshot,
    inputTokens:300000,outputAllowance:16384,
    availableModels:['gpt-5-mini','gpt-5.4-mini','gpt-5.4-pro','gpt-5.4','gpt-5.5-pro']};
  assert.equal(selectContextCapacityUpgrade(base),'gpt-5.4');
  assert.equal(selectContextCapacityUpgrade({...base,excludedModels:new Set(['gpt-5.4'])}),'gpt-5.4-pro');
  assert.equal(selectContextCapacityUpgrade({...base,inputTokens:1100000}),null,'an oversized quote is not dispatched');
  assert.equal(selectContextCapacityUpgrade({...base,availableModels:['gpt-5-mini','gpt-5.4-mini','unknown-alias']}),null);
  assert.equal(selectContextCapacityUpgrade({...base,availableModels:['gpt-5.5-pro']}),null,'nonstreaming candidate is not eligible');

  const oversized=freezePreparedRequest('openai','gpt-5.4-mini','/v1/responses',{
    model:'gpt-5.4-mini',input:[{role:'user',content:'x'.repeat(130000)}],max_output_tokens:16384,stream:true,
  });
  assert.equal(estimatePreparedRequest(oversized,snapshot).status,'unsupported');
  const native=estimatePreparedRequest(oversized,snapshot,{requestHash:oversized.hash,inputTokens:20000});
  assert.equal(native.status,'estimated','provider-native input count can avoid escalation');
  assert.equal(native.inputCountSource,'provider');
  // A higher-capacity model goes through the normal ledger and owner's cost
  // threshold; this is a quote, NOT approval to transmit the request.
  const expensive=freezePreparedRequest('openai','gpt-5.4','/v1/responses',{
    model:'gpt-5.4',input:[{role:'user',content:'x'.repeat(300000)}],max_output_tokens:16384,stream:true,
  });
  const quote=estimatePreparedRequest(expensive,snapshot);
  assert.equal(quote.status,'estimated');
  assert.ok(BigInt(quote.reservationMicrousd!)>1000000n,'an expensive upgrade must reach the existing approval gate');
});

test('only technical pre-dispatch context errors reroute; approval/uncertain spending never retries',async()=>{
  const executed:string[]=[];const rerouted:string[]=[];const current='claude-sonnet-4-5',newer='claude-sonnet-5',weaker='claude-haiku-5-5';
  const result=await runWithRefusalFallback({
    attempts:[current,weaker],shouldRetryRefusal:false,detectRefusal:()=>false,
    runAttempt:async model=>{executed.push(model);if(model===current)throw Object.assign(Error('context unverified'),{code:'standalone_context_capacity_unverified'});return {provider:'anthropic',model,text:'Ready'};},
    rerouteOnError:async()=>newer,
    onErrorReroute:({reroutedAttempt})=>{rerouted.push(reroutedAttempt);},
  });
  assert.deepEqual(executed,[current,newer]);assert.deepEqual(rerouted,[newer]);assert.equal(result.attempt,newer);
  for(const code of ['standalone_approval_required','standalone_outcome_unknown','standalone_unsupported_billing']){
    const attempted:string[]=[];let replacements=0;
    await assert.rejects(runWithRefusalFallback({
      attempts:[current,weaker],shouldRetryRefusal:true,detectRefusal:()=>false,
      runAttempt:async model=>{attempted.push(model);throw Object.assign(Error(code),{code});},
      rerouteOnError:async()=>{replacements++;return newer;},
    }),/standalone_/);
    assert.deepEqual(attempted,[current]);assert.equal(replacements,0);
  }
});
