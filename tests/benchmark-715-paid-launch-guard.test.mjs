import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyPaidOwner} from '../scripts/benchmark/owner-paid-nonfull-bootstrap.mjs';
import {assertBenchmarkDollarCeiling} from '../scripts/benchmark/paid-dollar-ceiling.mjs';

const id='123e4567-e89b-42d3-a456-426614174000';
const env={
 GITHUB_EVENT_NAME:'issues',GITHUB_ACTOR:'mfackrell',
 GITHUB_REPOSITORY_OWNER:'mfackrell',GITHUB_REPOSITORY:'mfackrell/katie',
 KATIE_BENCHMARK_PAID_EXECUTION:'enabled',KATIE_NONFULL_STAGING_ONLY:'verified',
 KATIE_NONFULL_STAGING_SUPABASE_URL:'https://iytvavgbaainnsrecmcx.supabase.co',
 KATIE_NONFULL_PRODUCTION_SUPABASE_URL:'https://barclcqataqyvifoeyop.supabase.co',
 KATIE_NONFULL_STAGING_SERVICE_ROLE_KEY:'fixture-not-real',KATIE_NONFULL_STAGING_OWNER_ID:id,
 OPENAI_API_KEY:'placeholder-credential-at-least-20-chars'
};
const event={action:'opened',repository:{full_name:'mfackrell/katie'},
 issue:{title:'[benchmark-715] Owner-approved paid three-arm execution',
 user:{login:'mfackrell'}}};
test('paid admission requires exact owner-authored issue and isolated staging',()=>{
 assert.equal(verifyPaidOwner(env,event),id);
 for(const broken of [
  {GITHUB_ACTOR:'intruder'},
  {GITHUB_REPOSITORY:'example/another'},
  {KATIE_BENCHMARK_PAID_EXECUTION:'disabled'},
  {KATIE_NONFULL_STAGING_SUPABASE_URL:env.KATIE_NONFULL_PRODUCTION_SUPABASE_URL},
  {OPENAI_API_KEY:''},
  {KATIE_NONFULL_STAGING_OWNER_ID:'not-an-id'},
  {KATIE_NONFULL_STAGING_ONLY:''}
 ])assert.throws(()=>verifyPaidOwner({...env,...broken},event),/DENIED/);
 for(const bad of [
  {...event,issue:{...event.issue,user:{login:'attacker'}}},
  {...event,issue:{...event.issue,title:'other'}},
  {...event,repository:{full_name:'not/katie'}}
 ])assert.throws(()=>verifyPaidOwner(env,bad),/DENIED/);
});
test('350,000 tokens stays within conservative $28/M $10 ceiling',()=>{
 const validated=assertBenchmarkDollarCeiling({
  armUsdCents:1000,priceCeilingMicrosPerMillion:28000000,
  publishedInputUsdPerMillion:1.75,publishedOutputUsdPerMillion:14,
  accountTokens:350000,approvalTokens:350000});
 assert.ok(validated.maxTokens>=350000);
 assert.throws(()=>assertBenchmarkDollarCeiling({
  armUsdCents:1000,priceCeilingMicrosPerMillion:28000000,
  publishedInputUsdPerMillion:1.75,publishedOutputUsdPerMillion:14,
  accountTokens:360000,approvalTokens:350000}),/CEILING_EXCEEDED/);
});
test('paid contained host reuses signed trust boundary, never a synthetic receipt',()=>{
 const runtime=readFileSync('scripts/benchmark/paid-staging-nonfull-runner.mjs','utf8');
 const gateway=readFileSync('scripts/benchmark/nonfull-trusted-gateway.mjs','utf8');
 assert.match(runtime,/createResponsesProvider/);
 assert.match(runtime,/assertTrustedBoundary/);
 assert.match(runtime,/providerNamespace:'openai-responses'/);
 assert.match(runtime,/privateBrowserAcceptance:'not-yet-verified'/);
 assert.match(gateway,/NONFULL_GATEWAY_PROVIDER_MODE_INVALID/);
});
