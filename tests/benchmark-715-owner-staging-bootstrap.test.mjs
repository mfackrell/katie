import test from 'node:test';
import assert from 'node:assert/strict';
import {frozenProtocol,protocolDigest,verifyOwnerEnvironment,bootstrap} from
 '../scripts/benchmark/owner-staging-bootstrap.mjs';

const uuid='aaaabbbb-cccc-4ddd-8eee-ffffffffffff';
const staging='https://iytvavgbaainnsrecmcx.supabase.co';
const event={repository:{full_name:'mfackrell/katie'},action:'opened',
 issue:{title:'[benchmark-715] Owner staging nonbillable qualification',user:{login:'mfackrell'}}};
const env={GITHUB_ACTOR:'mfackrell',GITHUB_REPOSITORY_OWNER:'mfackrell',
 GITHUB_REPOSITORY:'mfackrell/katie',GITHUB_EVENT_NAME:'issues',
 KATIE_NONFULL_STAGING_ONLY:'verified',KATIE_BENCHMARK_PAID_EXECUTION:'disabled',
 KATIE_NONFULL_STAGING_SUPABASE_URL:staging,
 KATIE_NONFULL_PRODUCTION_SUPABASE_URL:'https://production-example.supabase.co',
 KATIE_NONFULL_STAGING_SERVICE_ROLE_KEY:'only-server-side-key',
 KATIE_NONFULL_STAGING_OWNER_ID:uuid};
test('owner-authorized nonbillable isolated-staging gating',()=>{
 assert.equal(verifyOwnerEnvironment(env,event),uuid);
 for(const [mod,ev] of [
  [{GITHUB_ACTOR:'attacker'},event],
  [{GITHUB_REPOSITORY:'other/repo'},event],
  [{KATIE_NONFULL_STAGING_SUPABASE_URL:env.KATIE_NONFULL_PRODUCTION_SUPABASE_URL},event],
  [{KATIE_NONFULL_STAGING_SUPABASE_URL:'https://attacker.supabase.co'},event],
  [{KATIE_BENCHMARK_PAID_EXECUTION:'enabled'},event],
  [{OPENAI_API_KEY:'secret'},event],
  [{KATIE_NONFULL_STAGING_ONLY:'false'},event],
  [{KATIE_NONFULL_STAGING_OWNER_ID:'not-uuid'},event],
  [{}, {...event,issue:{...event.issue,user:{login:'attacker'}}}],
  [{}, {...event,issue:{...event.issue,title:'anything else'}}]
 ])assert.throws(()=>verifyOwnerEnvironment({...env,...mod},ev),/DENIED/);
});
test('one immutable baseline and protocol digest across arms',()=>{
 const p=frozenProtocol();
 assert.equal(p.baselineSha,'0015bcdb8ac9ad94b7c74d1a4cd76737903b1319');
 assert.match(p.contract_sha256,/^[0-9a-f]{64}$/);
 assert.match(protocolDigest({experiment_id:uuid,replicate:1,
  baseline_sha:p.baselineSha,contract_sha256:p.contract_sha256,
  acceptance_sha256:p.acceptance_sha256,tool_profile_sha256:p.tool_profile_sha256,
  model_policy_sha256:p.model_policy_sha256,runtime_sha256:p.runtime_sha256},
 350000),/^[0-9a-f]{64}$/);
});
function fakeDb({priceStatus='verified',existingTrials=0,rows=117}={}){
 let sequence=0;
 const records={actors:[],chats:[],benchmark_three_arm_trials:[],
  benchmark_budget_accounts:[],benchmark_native_spending_approvals:[]};
 const db={from(table){
  return {
   select(_fields,options){
    if(options?.head)return {then:(resolve,reject)=>Promise.resolve({
     count:table==='schema_migrations'?rows:
       table==='benchmark_three_arm_trials'?existingTrials:records[table]?.length,
     error:null}).then(resolve,reject)};
    return {eq:()=>({eq:()=>({maybeSingle:async()=>({
     data:{model_id:'gpt-5.3-codex',pricing_status:priceStatus,
      pricing_input_per_1m:1.75,pricing_output_per_1m:14},error:null})})})};
   },
   insert(value){return {select(){return {single:async()=>{
    const data={id:'record-'+(++sequence),...value};
    records[table].push(data);return {data,error:null};
   }}}}}
  };
 }};
 return {db,records};
}
test('bootstrap creates three equal capped trials, but never fabricates Full spending permission',async()=>{
 const {db,records}=fakeDb();
 const result=await bootstrap({db,ownerId:uuid});
 assert.equal(result.arms.length,3);
 assert.deepEqual(result.arms.map(x=>x.arm),['native','thin','full']);
 assert.deepEqual(result.arms.map(x=>x.state),['qualified','qualified','planned']);
 assert.equal(records.benchmark_budget_accounts.length,3);
 assert.ok(records.benchmark_budget_accounts.every(x=>x.cap_tokens===350000));
 assert.equal(records.benchmark_native_spending_approvals.length,2);
 assert.equal(result.arms[2].approvalId,null);
 assert.equal(records.benchmark_native_spending_approvals[0].owner_id,uuid);
 assert.equal(records.benchmark_three_arm_trials[0].contract_sha256,
              records.benchmark_three_arm_trials[2].contract_sha256);
});
test('dirty schema or missing verified pricing must stop before any grants',async()=>{
 for(const options of [{priceStatus:'estimated'},{existingTrials:1},{rows:116}]){
  const {db,records}=fakeDb(options);
  await assert.rejects(bootstrap({db,ownerId:uuid}),/DENIED/);
  assert.equal(records.benchmark_native_spending_approvals.length,0);
 }
});
