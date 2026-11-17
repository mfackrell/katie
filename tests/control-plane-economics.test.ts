import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiProvider } from '@/lib/providers/openai-provider';
import { captureControlPlanePreparation, rankControlPlaneByActualCost } from '@/lib/router/control-plane-economics';
import { prepareStandaloneRequest } from '@/lib/standalone-accounting/estimate';
import { StandaloneAccountingError } from '@/lib/standalone-accounting/ledger';
import { resolveProjectTransition } from '@/lib/router/model-intent';
import type { LlmProvider } from '@/lib/providers/types';
import { selectControlPlaneDecisionModels } from '@/lib/router/master-router';
import { runWithStandaloneAccounting, runWithOrchestratorAccounting, getAccountingScope, nextStandaloneAttempt } from '@/lib/standalone-accounting/context';
import { PRICING_SNAPSHOT, type PricingSnapshot } from '@/lib/standalone-accounting/pricing';

const owner = {userId:'owner',actorId:'actor',chatId:'chat',requestId:'routine-intention'};
const params = {name:'Katie Control Plane',persona:'Return strict JSON routing decisions.',summary:'',history:[],user:'Classify the intent of: morning Katie'};
// Deliberately synthetic regression prices, never published or used in production.
const pricing: PricingSnapshot = {...PRICING_SNAPSHOT,version:'test-cost-comparison',models:[
  {provider:'openai',model:'gpt-5.6-sol',inputNanoUsd:'100000',outputNanoUsd:'1000000',maxContextTokens:1_000_000,maxOutputTokens:100_000,source:'test fixture'},
  {provider:'openai',model:'gpt-5-mini',inputNanoUsd:'100',outputNanoUsd:'1000',maxContextTokens:1_000_000,maxOutputTokens:100_000,source:'test fixture'},
]};

test('routine helper compares qualified serialized requests before choosing expensive curated-first model', async () => {
  const originalFetch = globalThis.fetch;
  let transmissions=0;
  globalThis.fetch = async () => {transmissions++;throw Error('No provider transmission allowed in quotation test');};
  try {
    const provider = new OpenAiProvider('test-not-a-real-key');
    await runWithStandaloneAccounting(owner,async () => {
      const candidates = selectControlPlaneDecisionModels([{provider,models:['gpt-5.6-sol','gpt-5-mini']}]);
      assert.deepEqual(candidates.map(c=>c.modelId),['gpt-5.6-sol','gpt-5-mini']);
      const ranked = await rankControlPlaneByActualCost(candidates,params,pricing);
      assert.deepEqual(ranked.map(c=>c.modelId),['gpt-5-mini','gpt-5.6-sol']);
      const scope=getAccountingScope();
      assert.equal(scope?.kind === 'standalone' ? scope.counter.size : -1,0,'quotation must not consume attempt identities');
    });
    assert.equal(transmissions,0);
  } finally {globalThis.fetch=originalFetch;}
});

test('unknown prices never win over a validated qualified helper', async () => {
  const provider = new OpenAiProvider('test-not-a-real-key');
  await runWithStandaloneAccounting(owner,async () => {
    const candidates = [{provider,modelId:'gpt-5.6-sol'},{provider,modelId:'gpt-5-mini'}];
    const ranked=await rankControlPlaneByActualCost(candidates,params,{...pricing,models:pricing.models.slice(1)});
    assert.deepEqual(ranked.map(c=>c.modelId),['gpt-5-mini']);
  });
});

test('Developer Orchestrator selection and accounting do not enter standalone economics', async () => {
  const provider = new OpenAiProvider('test-not-a-real-key');
  await runWithOrchestratorAccounting(async () => {
    const candidates = selectControlPlaneDecisionModels([{provider,models:['gpt-5.6-sol','gpt-5-mini']}]);
    assert.deepEqual(candidates.map(c=>c.modelId),['gpt-5.6-sol']);
    assert.equal(await rankControlPlaneByActualCost(candidates,params,pricing),candidates);
  });
});

test('resume restores each fallback ordinal after an invalid completed helper and an approved second helper', async () => {
  const originalFetch=globalThis.fetch;
  const originalUrl=process.env.NEXT_PUBLIC_SUPABASE_URL, originalKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL='https://accounting.test';process.env.SUPABASE_SERVICE_ROLE_KEY='test-only-key';
  const a='gpt-5-mini', b='gpt-5.4', c='gpt-5.6-sol';
  const snapshot={...pricing,models:[pricing.models[1],{...pricing.models[1],model:b,inputNanoUsd:'200',outputNanoUsd:'2000'},pricing.models[0]]};
  const attempts=new Map<string,{provider:string;model:string;state:string;response:string}>();
  const sent:string[]=[];
  let approved=false;
  globalThis.fetch=async (input,init) => {
    const url=String(input),body=JSON.parse(String(init?.body));
    if(url.endsWith('/standalone_lookup_attempt'))return Response.json(attempts.get(body.p_key)??null);
    if(url.endsWith('/standalone_load_pricing'))return Response.json({snapshot,retrievedAt:new Date().toISOString()});
    throw Error('Unexpected network request in isolated helper regression');
  };
  const provider:LlmProvider={name:'openai',async listModels(){return[a,c,b];},async generate(params){
    const model=params.modelId!;
    captureControlPlanePreparation(prepareStandaloneRequest('openai',model,'/v1/chat/completions',{model,messages:[{role:'user',content:params.user}],max_completion_tokens:4096}));
    const scope=nextStandaloneAttempt()!;
    const saved=attempts.get(scope.attemptKey);
    if(saved)assert.equal(model,saved.model,'the next saved ordinal must select its original model');
    if(saved?.state==='settled')return {text:saved.response,model,provider:'openai'};
    if(model===b&&!approved){attempts.set(scope.attemptKey,{provider:'openai',model,state:'paused',response:''});throw new StandaloneAccountingError('approval_required','Approve saved B');}
    assert.notEqual(model,c,'unrelated fallback must not replace saved B');
    sent.push(model);
    const response=model===a?'invalid JSON':JSON.stringify({executionKind:'conversation',action:'same'});
    attempts.set(scope.attemptKey,{provider:'openai',model,state:'settled',response});
    return {text:response,model,provider:'openai'};
  }};
  const run=()=>resolveProjectTransition('review this patch for routing bugs in repo files',{activeProject:{userMessageId:'original',text:'Review routing'},savedProjects:[]},{decisionProviders:[a,c,b].map(modelId=>({provider,modelId}))});
  try{
    await assert.rejects(runWithStandaloneAccounting(owner,run),/Approve saved B/);
    assert.deepEqual(sent,[a]);
    approved=true;
    const result=await runWithStandaloneAccounting({...owner,resumed:true},run);
    assert.equal(result,undefined,'the approved project decision is returned');
    assert.deepEqual(sent,[a,b],'completed A is replayed and only approved B transmits');
    assert.equal(attempts.size,2);
  }finally{
    globalThis.fetch=originalFetch;
    if(originalUrl===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_URL;else process.env.NEXT_PUBLIC_SUPABASE_URL=originalUrl;
    if(originalKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=originalKey;
  }
});


test('resume past an unavailable, settled zero-cost provider rejection preserves the next approved fallback ordinal', async () => {
  const originalFetch=globalThis.fetch;
  const originalUrl=process.env.NEXT_PUBLIC_SUPABASE_URL, originalKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL='https://accounting.test';process.env.SUPABASE_SERVICE_ROLE_KEY='test-only-key';
  const prefix='control_plane_project-resolution:';
  const rejected={
    provider:'anthropic',model:'claude-haiku-5-5',state:'settled',actual_microusd:'0',
    usage:{inputTokens:0,outputTokens:0,nonbillableRejected:true},
    evidence:{kind:'provider_rejection',rejectionReason:'insufficient_prepaid_balance',httpStatus:400},
    response_checkpoint:{status:400},
  };
  const fallback={provider:'openai',model:'gpt-5-mini',state:'paused'};
  const attempts=new Map<string,Record<string,unknown>>([[prefix+'0',rejected],[prefix+'1',fallback]]);
  const seen:string[]=[];
  let transmissions=0;
  globalThis.fetch=async (input,init) => {
    const url=String(input),body=JSON.parse(String(init?.body));
    if(url.endsWith('/standalone_lookup_attempt'))return Response.json(attempts.get(body.p_key)??null);
    throw Error('Unexpected provider or ledger network request in recovery test');
  };
  const provider:LlmProvider={name:'openai',async listModels(){return ['gpt-5-mini'];},async generate(params){
    const attempt=nextStandaloneAttempt()!;
    seen.push(attempt.attemptKey);
    assert.equal(attempt.attemptKey,prefix+'1','the saved fallback must keep its original ordinal');
    assert.equal(params.modelId,fallback.model,'the approved model must be unchanged');
    if(fallback.state==='paused')throw new StandaloneAccountingError('approval_required','Approve saved fallback');
    transmissions++;
    return {text:JSON.stringify({executionKind:'conversation',action:'same'}),provider:'openai',model:'gpt-5-mini'};
  }};
  const run=()=>resolveProjectTransition('review the routing for this project',
    {activeProject:{userMessageId:'old',text:'Review routing'},savedProjects:[]},
    {decisionProviders:[{provider,modelId:'gpt-5-mini'}]});
  try {
    await assert.rejects(runWithStandaloneAccounting({...owner,requestId:'rejected-resume',resumed:true},run),/Approve saved fallback/);
    assert.equal(transmissions,0,'an unapproved saved fallback cannot transmit');
    fallback.state='reserved';
    const result=await runWithStandaloneAccounting({...owner,requestId:'rejected-resume',resumed:true},run);
    assert.equal(result,undefined);
    assert.equal(transmissions,1,'only the exact approved fallback transmits');
    assert.deepEqual(seen,[prefix+'1',prefix+'1']);
    assert.deepEqual([...attempts.keys()],[prefix+'0',prefix+'1'],'no attempt key was replaced or appended');
  } finally {
    globalThis.fetch=originalFetch;
    if(originalUrl===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_URL;else process.env.NEXT_PUBLIC_SUPABASE_URL=originalUrl;
    if(originalKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=originalKey;
  }
});

test('missing saved provider fails closed for completed output, pending, uncertain, and unverified rejection', async () => {
  const originalFetch=globalThis.fetch;
  const originalUrl=process.env.NEXT_PUBLIC_SUPABASE_URL, originalKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL='https://accounting.test';process.env.SUPABASE_SERVICE_ROLE_KEY='test-only-key';
  const verified={
    provider:'anthropic',model:'claude-haiku-5-5',state:'settled',actual_microusd:'0',
    usage:{nonbillableRejected:true},evidence:{kind:'provider_rejection',rejectionReason:'insufficient_prepaid_balance',httpStatus:400},
    response_checkpoint:{status:400},
  };
  let saved:Record<string,unknown>=verified;
  let transmissions=0;
  globalThis.fetch=async (input,init) => {
    const url=String(input),body=JSON.parse(String(init?.body));
    if(url.endsWith('/standalone_lookup_attempt')) {
      assert.equal(body.p_key,'control_plane_intent-classification:0');
      return Response.json(saved);
    }
    throw Error('Unexpected network request in fail-closed test');
  };
  const provider:LlmProvider={name:'openai',async listModels(){return ['gpt-5-mini'];},async generate(){
    transmissions++;
    throw Error('Must not quote or dispatch while saved attempt is unresolved');
  }};
  const invalid=[
    {...verified,state:'reserved'},
    {...verified,state:'paused'},
    {...verified,state:'dispatched'},
    {...verified,state:'uncertain'},
    {...verified,state:'settled',usage:{nonbillableRejected:false}},
    {...verified,state:'settled',actual_microusd:'1'},
    {...verified,state:'settled',evidence:{kind:'provider_receipt'}},
    {...verified,state:'settled',response_checkpoint:{status:200}},
  ];
  try {
    for(const candidate of invalid) {
      saved=candidate;
      await assert.rejects(
        runWithStandaloneAccounting({...owner,requestId:'strict-unavailable-resume',resumed:true},
          () => rankControlPlaneByActualCost([{provider,modelId:'gpt-5-mini'}],params,undefined,'control_plane_intent-classification')),
        (error:unknown) => error instanceof Error && error.message.includes('no longer available for exact resume')
      );
    }
    assert.equal(transmissions,0,'no replacement dispatch or pricing probe was allowed');
  } finally {
    globalThis.fetch=originalFetch;
    if(originalUrl===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_URL;else process.env.NEXT_PUBLIC_SUPABASE_URL=originalUrl;
    if(originalKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=originalKey;
  }
});
