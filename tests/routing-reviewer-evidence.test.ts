import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import * as admin from '@/lib/data/supabase/admin';
import { resolveReviewerRoutingEvidence } from '@/lib/router/reviewer-evidence';
import { runWithStandaloneAccounting, getAccountingScope } from '@/lib/standalone-accounting/context';
import { OpenAiProvider } from '@/lib/providers/openai-provider';
import { ClaudeProvider } from '@/lib/providers/claude-provider';
import { rankControlPlaneByActualCost } from '@/lib/router/control-plane-economics';
import { PRICING_SNAPSHOT } from '@/lib/standalone-accounting/pricing';

const scope={userId:'owner',actorId:'actor',chatId:'chat',requestId:'current'};
const candidates=[{providerName:'openai',modelId:'gpt-4o-mini'},{providerName:'anthropic',modelId:'claude-sonnet-4-6'}];
test('review evidence uses authenticated scope, projects only aggregates, and fails unknown',async()=>{
 let calls=0;let error=false;
 const rpc=mock.method(admin,'getSupabaseAdminClient',()=>({rpc:async(name:string,args:unknown)=>{
  calls++;assert.equal(name,'standalone_routing_reviewer_evidence');
  assert.deepEqual(args,{p_owner:'owner',p_actor:'actor',p_chat:'chat',p_request:'current',p_intent:'rewrite'});
  return error?{error:{message:'unavailable'}}:{data:{observations:[{provider:'openai',model:'gpt-4o-mini',sample_count:2,approvals:1,revisions:1,first_observation:'2026-11-16',latest_observation:'2026-11-17',draft:'PRIVATE CONTENT',reviewer:'PRIVATE ID'},{provider:'other',model:'unlisted'}]}};
 }}));
 try{
  assert.equal((await resolveReviewerRoutingEvidence('rewrite',candidates)).status,'unknown');assert.equal(calls,0);
  await runWithStandaloneAccounting(scope,async()=>{
   const result=await resolveReviewerRoutingEvidence('rewrite',candidates);
   assert.equal(result.observations.length,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
   assert.match(JSON.stringify(result),/independent_model_reviewer_with_prior_assessment/);
   error=true;assert.equal((await resolveReviewerRoutingEvidence('rewrite',candidates)).status,'unknown');
   assert.equal((getAccountingScope() as {counter:Map<string,number>}).counter.size,0);
  });
 }finally{rpc.mock.restore();}
});

for(const task of ['Hello Katie','Write a board memo','Implement payment recovery','Continue this poem','Write an emotionally careful reply','Explain the screenshot']){
 test(`review evidence leaves native serialized preparation and pricing intact: ${task}`,async()=>{
  const fetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('No paid calls');};
  try{await runWithStandaloneAccounting(scope,async()=>{
   for(const [provider,model] of [[new OpenAiProvider('test-key'),'gpt-4o-mini'],[new ClaudeProvider('test-key'),'claude-sonnet-4-6']] as const){
    const result=await rankControlPlaneByActualCost([{provider,modelId:model}],{name:'Katie',persona:'Actor voice',summary:'Scoped memory',history:[],user:task},PRICING_SNAPSHOT);
    assert.equal(result[0]?.modelId,model);
   }
  });}finally{globalThis.fetch=fetch;}
  assert.equal(calls,0);
 });
}
