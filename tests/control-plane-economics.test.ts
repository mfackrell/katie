import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiProvider } from '@/lib/providers/openai-provider';
import { rankControlPlaneByActualCost } from '@/lib/router/control-plane-economics';
import { selectControlPlaneDecisionModels } from '@/lib/router/master-router';
import { runWithStandaloneAccounting, runWithOrchestratorAccounting, getAccountingScope } from '@/lib/standalone-accounting/context';
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
