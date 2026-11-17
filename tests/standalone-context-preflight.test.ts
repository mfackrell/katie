import test from 'node:test';
import assert from 'node:assert/strict';
import { countNativePreparedInput } from '../lib/standalone-accounting/native-token-count';
import { selectContextCapacityUpgrade, isReviewedCrossProviderContextCandidate } from '../lib/standalone-accounting/context-upgrade';
import { chooseCrossProviderContextRecovery } from '../lib/chat/context-capacity-recovery';
import type { LlmProvider } from '../lib/providers/types';
import { readFileSync } from 'node:fs';
import { estimatePreparedRequest, freezePreparedRequest, PROVIDER_COUNT_ESTIMATOR_VERSION } from '../lib/standalone-accounting/estimate';
import { getModelPrice, PRICING_SNAPSHOT } from '../lib/standalone-accounting/pricing';
import { runWithRefusalFallback } from '../lib/router/refusal-detection';
import { classifyGenerationFailure, describeGenerationFailure } from '../lib/router/provider-error';
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
  assert.equal(standaloneTechnicalBlocker('standalone_unsupported_billing'),true,
    'Unknown provider-native tool fees cannot be resolved by owner approval or left processing');
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
    assert.deepEqual(JSON.parse(String(init?.body)),{generateContentRequest:{model:'models/gemini-2.5-pro',contents:google.payload.contents}});
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

test('pre-dispatch context codes do not masquerade as paid provider failures, including nested SDK causes',()=>{
  const uncertain=Object.assign(new Error('local capacity unknown'),{code:'standalone_context_capacity_unverified'});
  const overflow=Object.assign(new Error('local verified overflow'),{code:'standalone_context_window_exceeded'});
  assert.equal(classifyGenerationFailure(uncertain),'model');
  assert.equal(describeGenerationFailure(uncertain),'context capacity could not be verified before generation');
  assert.equal(classifyGenerationFailure({cause:{cause:overflow}}),'model');
  assert.equal(describeGenerationFailure({cause:{cause:overflow}}),"verified input plus output exceeds the selected model's context window");
  const actualProviderError=Object.assign(new Error('provider rate limit'),{status:429,code:'rate_limit'});
  assert.equal(classifyGenerationFailure(actualProviderError),'provider');
  assert.equal(describeGenerationFailure(actualProviderError),'the provider rate-limited the request');
});

test('Gemini image counting preserves exact visual inputs but excludes uncountable output settings',async()=>{
  const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(1,16);png.writeUInt32BE(1,20);
  const inline={inlineData:{mimeType:'image/png',data:png.toString('base64')}};
  const system={role:'user',parts:[{text:'Keep this character visually consistent.'}]};
  const contents=[{role:'user',parts:[{text:'Create a portrait'},inline]}];
  const prepared=freezePreparedRequest('google','gemini-3.1-flash-image',
    '/v1beta/models/gemini-3.1-flash-image:streamGenerateContent',
    {contents,systemInstruction:system,generationConfig:{
      responseModalities:['TEXT','IMAGE'],imageConfig:{imageSize:'1K'},maxOutputTokens:4096,
    }});
  const unchanged=prepared.serializedBody;
  let counts=0;
  const result=await countNativePreparedInput(prepared,async(url,init)=>{
    counts++;
    assert.equal(String(url),'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:countTokens');
    const body=JSON.parse(String(init?.body));
    assert.deepEqual(body,{generateContentRequest:{model:'models/gemini-3.1-flash-image',contents,systemInstruction:system}});
    assert.equal('generationConfig' in body.generateContentRequest,false,'output settings cannot poison the input count');
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'),'fixture-not-a-real-key');
    return Response.json({totalTokens:74004});
  },{'x-goog-api-key':'fixture-not-a-real-key'});
  assert.equal(result,74004);
  assert.equal(counts,1,'only the free countTokens request was sent');
  assert.equal(prepared.serializedBody,unchanged,'counting must not mutate the frozen paid request');
  assert.equal(estimatePreparedRequest(prepared,PRICING_SNAPSHOT,{requestHash:prepared.hash,inputTokens:result!}).status,'estimated');
});

test('image context escalation rejects larger text models and permits only reviewed image-generation upgrades',()=>{
  const image=getModelPrice('google','gemini-3.1-flash-image')!;
  const biggerText={...image,model:'gemini-3.8-flash',maxContextTokens:1000000,
    imageOutputNanoUsd:undefined,imageOutputTokensPerImage:undefined};
  const biggerImage={...image,model:'gemini-3.2-pro-image',maxContextTokens:260000};
  const pricing={...PRICING_SNAPSHOT,models:[...PRICING_SNAPSHOT.models,biggerText,biggerImage]};
  const original={provider:'google' as const,model:image.model,pricing,inputTokens:155000,
    outputAllowance:5216};
  assert.equal(selectContextCapacityUpgrade({...original,availableModels:['gemini-3.8-flash']}),null,
    'the November 5 context bug must not select Gemini text in place of image generation');
  assert.equal(selectContextCapacityUpgrade({...original,availableModels:['gemini-3.8-flash','gemini-3.2-pro-image']}),
    'gemini-3.2-pro-image','a genuinely image-priced, larger-capacity model can be selected');
  assert.equal(selectContextCapacityUpgrade({...original,availableModels:['gemini-3.2-pro-image'],inputTokens:259000}),null,
    'a genuine image model must still fit full context');
});


test('Nov 17 GPT-4o-mini overflow is eligible for another reviewed provider, not another cheap model', () => {
  const inputTokens=130000,outputAllowance=16384;
  assert.equal(selectContextCapacityUpgrade({
    provider:'openai',model:'gpt-4o-mini',availableModels:['gpt-4o-mini','gpt-4o'],
    pricing:PRICING_SNAPSHOT,inputTokens,outputAllowance,
  }),null,'existing same-provider lineage upgrade is unavailable');
  const candidate=(provider:'openai'|'anthropic'|'google'|'grok',model:string) =>
    isReviewedCrossProviderContextCandidate({provider,model,pricing:PRICING_SNAPSHOT,inputTokens,outputAllowance});
  assert.equal(candidate('openai','gpt-4o-mini'),false,'the failed 128K-window model is ineligible');
  assert.equal(candidate('openai','gpt-4o'),false,'same limited 128K context is ineligible');
  assert.equal(candidate('anthropic','claude-sonnet-5-5'),true,'reviewed 1M-window Claude can fit');
  assert.equal(candidate('google','gemini-2.5-flash'),true,'reviewed 1M-window Gemini can fit');
  assert.equal(candidate('openai','unreviewed-super-model'),false,'no aliases or unreviewed pricing');
  assert.equal(candidate('google','gemini-3.1-flash-image'),false,'an image-output model is not a text recovery');
  assert.equal(isReviewedCrossProviderContextCandidate({
    provider:'anthropic',model:'claude-sonnet-5-5',pricing:PRICING_SNAPSHOT,
    inputTokens:1000000,outputAllowance,
  }),false,'the full unchanged request must fit');
  assert.equal(isReviewedCrossProviderContextCandidate({
    provider:'anthropic',model:'claude-sonnet-5-5',pricing:PRICING_SNAPSHOT,
    inputTokens:130000,outputAllowance:70000,
  }),false,'do not silently reduce the output allowance');
});

test('Nov 17 exact capacity failure flows through recovery and an LLM-picked other provider', async () => {
  const inputTokens=130000,outputAllowance=16384;
  const user='not a seafood fan. i usually have my special smoothie for lunch and some grilled chicken for dinner';
  const unchanged={
    name:'Katie',persona:'The same original actor and policy instructions.',
    summary:'Original memory remains unchanged.',
    user,history:[{role:'assistant' as const,content:'What is for lunch?'}],
  };
  const original=JSON.stringify(unchanged);
  const providerCalls:string[]=[];
  let routerCalls=0;
  const openai:LlmProvider={
    name:'openai',async listModels(){return ['gpt-4o-mini'];},
    async generate(){throw Error('Original provider should be rejected before paid dispatch');},
  };
  const claude:LlmProvider={
    name:'anthropic',async listModels(){return ['claude-sonnet-5-5'];},
    async generate(){throw Error('Mocked responder must not be used as the control-plane selector');},
  };
  // A control-plane model need not be the provider selected to answer.
  // Gemini 2.5 Pro is on the verified decision-model list; Sonnet 5.5 is
  // an eligible response model but is not on that decision-model list.
  const google:LlmProvider={
    name:'google',async listModels(){return ['gemini-2.5-pro'];},
    async generate({modelId}) {
      routerCalls++;
      return {provider:'google',model:modelId??'gemini-2.5-pro',
        text:JSON.stringify({selected:{provider:'anthropic',model:'claude-sonnet-5-5'},
          selection_justification:'Reviewed capacity and full-context fit for this conversation.',
          alternatives:[{provider:'google',model:'gemini-2.5-pro',why_not_selected:'Less established conversational continuity for this exact recovery fixture.'}]})};
    },
  };
  const intent={
    intent:'social-emotional' as const,preferredProvider:null,intentSource:'upstream' as const,
    responsePurpose:'conversation' as const,secondaryIntents:[] as [],
    decisionEvidence:{classification_model:'claude-sonnet-5-5'},
  };
  const result=await runWithRefusalFallback({
    attempts:[{provider:openai,modelId:'gpt-4o-mini'}],
    shouldRetryRefusal:false,detectRefusal:()=>false,
    runAttempt:async attempt=>{
      providerCalls.push(attempt.provider.name+':'+attempt.modelId);
      assert.equal(JSON.stringify(unchanged),original,'never drop memories, history, or user message');
      if(attempt.provider.name==='openai'){
        throw Object.assign(new Error('Capacity unverified before paid dispatch'),{
          code:'standalone_context_capacity_unverified',
        });
      }
      return {provider:'anthropic',model:attempt.modelId,
        text:'A smoothie and grilled chicken? You have your lunch routine figured out.'};
    },
    rerouteOnError:async ({attempt,attemptedAttempts,error})=>{
      assert.equal((error as {code?:string}).code,'standalone_context_capacity_unverified');
      assert.equal(attempt.provider.name,'openai');
      assert.equal(selectContextCapacityUpgrade({
        provider:'openai',model:attempt.modelId,pricing:PRICING_SNAPSHOT,
        availableModels:await openai.listModels(),inputTokens,outputAllowance,
      }),null);
      const selection=await chooseCrossProviderContextRecovery({
        message:user,conversationContext:'Continuing ordinary conversation, not asking for a new task.',
        providers:[openai,claude,google],failedProviderNames:new Set(),
        previousAttempts:attemptedAttempts.map(item=>({
          providerName:item.provider.name,modelId:item.modelId,
        })),otherExcluded:[],pricing:PRICING_SNAPSHOT,inputTokens,outputAllowance,
        attachments:[],resolvedIntent:intent,routingMode:'best_answer',
        routingRequestParams:async()=>({...unchanged,requestIntent:'social-emotional'}),
        routingRequestId:'fixture-nov17-cross-provider',actorId:'actor-test',
        routingHints:[],routingTraceEnabled:false,
      });
      assert.ok(selection,'a reviewed cross-provider replacement is available');
      assert.equal(selection.explainer?.selected_source,'llm-primary',
        'the LLM, not deterministic routing, chooses the fallback');
      assert.deepEqual(selection.resolvedIntent.secondaryIntents,[]);
      assert.equal(selection.resolvedIntent.responsePurpose,'conversation');
      return {provider:selection.provider,modelId:selection.modelId};
    },
  });
  assert.ok(routerCalls>=1,'recovery invoked the existing LLM router');
  assert.deepEqual(providerCalls,['openai:gpt-4o-mini','anthropic:claude-sonnet-5-5']);
  assert.equal(result.attempt.provider.name,'anthropic');
  assert.match(result.result.text,/smoothie/);
  assert.equal(JSON.stringify(unchanged),original,'the original full context was never altered');
});

test('cross-provider capacity recovery is bounded and never bypasses pricing or failed-provider exclusions',async()=>{
  const openai:LlmProvider={name:'openai',async listModels(){return ['gpt-4o-mini'];},
    async generate(){throw Error('No recovered provider should run');}};
  const result=await chooseCrossProviderContextRecovery({
    message:'Lunch?',conversationContext:'',providers:[openai],failedProviderNames:new Set(),
    previousAttempts:[{providerName:'openai',modelId:'gpt-4o-mini'}],otherExcluded:[],
    pricing:PRICING_SNAPSHOT,inputTokens:130000,outputAllowance:16384,attachments:[],
    resolvedIntent:{intent:'general-text',preferredProvider:null,intentSource:'upstream'},
    routingMode:'best_value',routingRequestParams:async()=>({
      name:'Katie',persona:'unchanged',summary:'',user:'Lunch?',history:[],
    }),routingRequestId:'fixture-no-recovery',actorId:'actor-test',routingHints:[],
  });
  assert.equal(result,null);
  const code=readFileSync('app/api/chat/route.ts','utf8');
  assert.match(code,/chooseCrossProviderContextRecovery\(\{/);
  assert.match(code,/!resolvedRoutingIntentForReroute \|\|\s*errorRerouteCount >= maxErrorReroutes/);
  assert.match(code,/if \(accounting && \['standalone_context_capacity_unverified','standalone_context_window_exceeded'\]/);
  assert.match(code,/if \(imageGenerationRequested \|\| \(overrideProvider && overrideModel\)/);
  assert.match(code,/Boolean\(visualContinuity\?\.references\.length\)/,
    'saved visual references must not enter text-only recovery');
});
