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
