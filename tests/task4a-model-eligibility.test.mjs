import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {retrieveNativeModelNonbillable,assertNativeModelEligibility,nativeCredentialBinding,
 TASK4A_MODEL_LOOKUP_URL} from '../scripts/benchmark/native-provider-receipts.mjs';

const now=Date.parse('2026-11-06T12:00:00.000Z');
const release='a'.repeat(40);
const apiKey='synthetic-only-test-api-key-not-a-credential';
const signingKey='synthetic-only-test-hmac-key-not-a-credential';
const fake=({status=200,body={object:'model',id:'gpt-5.3-codex',owned_by:'openai'},contentType='application/json'}={})=>
 new Response(JSON.stringify(body),{status,headers:{'content-type':contentType}});
const attest=async(params={})=>retrieveNativeModelNonbillable({apiKey,signingKey,now,fetchImpl:async(url,options)=>{
 assert.equal(url,TASK4A_MODEL_LOOKUP_URL);
 assert.equal(options.method,'GET');
 assert.equal(options.body,undefined,'No inference request body');
 assert.equal(options.headers.Authorization,'Bearer '+apiKey);
 assert.equal(options.redirect,'error');
 return fake(params);
}});
const complete=e=>({...e,releaseSha:release,githubRepository:'mfackrell/katie',
 githubWorkflow:'.github/workflows/autonomous-development.yml',
 trustedProducer:'protected-main-read-only-model-lookup'});
const registry=e=>({provider_name:'openai',model_id:'gpt-5.3-codex',is_active:true,
 capability_status:'verified',routing_eligibility:'verified',
 capability_verified_at:new Date(now).toISOString(),pricing_status:'verified',
 pricing_verified_at:new Date(now).toISOString(),
 pricing_input_per_1m:1.75,pricing_output_per_1m:14,
 source_metadata:{task4a_credential_lookup:e,
 pricing_verification_source:'https://developers.openai.com/api/docs/models/gpt-5.3-codex'}});
const allowed=(e,r,at=now,key=apiKey)=>assertNativeModelEligibility({
 evidence:e,registry:r,releaseSha:release,apiKey:key,signingKey,now:at});
test('Trusted native helper makes only authenticated, read-only, exact-model GET',async()=>{
 const e=complete(await attest());
 assert.equal(e.httpStatus,200);
 assert.equal(e.model,'gpt-5.3-codex');
 assert.equal(e.credentialSource,'github-actions:OPENAI_API_KEY');
 assert.equal(e.organizationContext,'key-default');
 assert.equal(e.projectContext,'key-default');
 assert.equal(e.proofLevel,'credential_scoped_model_visibility_not_responses_create');
 assert.equal(e.credentialBinding,nativeCredentialBinding({apiKey,signingKey}));
 assert.equal(allowed(e,registry(e)),true);
});
test('An active model and fresh official pricing alone NEVER permit native eligibility',async()=>{
 const good=complete(await attest()),base=registry(good);
 const variants=[
  {name:'missing record',record:null},
  {name:'missing evidence',record:{...base,source_metadata:{pricing_verification_source:base.source_metadata.pricing_verification_source}}},
  {name:'restricted routing',record:{...base,routing_eligibility:'restricted'}},
  {name:'heuristic capability',record:{...base,capability_status:'heuristic'}},
  {name:'stale capability',record:{...base,capability_verified_at:new Date(now-16*60*1000).toISOString()}},
  {name:'missing capability verification',record:{...base,capability_verified_at:null}},
  {name:'wrong org/project context',evidence:{...good,projectContext:'other-project'},record:base},
  {name:'wrong credential source',evidence:{...good,credentialSource:'vercel:OPENAI_API_KEY'},record:base},
  {name:'rotated key',record:base,key:'changed-synthetic-credential-with-sufficient-length'},
  {name:'wrong credential binding',evidence:{...good,credentialBinding:'0'.repeat(64)},record:base},
  {name:'stale lookup',record:base,at:now+16*60*1000},
  {name:'replayed release',evidence:{...good,releaseSha:'b'.repeat(40)},record:base},
  {name:'wrong model',evidence:{...good,model:'gpt-6-sol'},record:base},
  {name:'wrong endpoint',evidence:{...good,endpoint:'https://other.example/v1/models/gpt-5.3-codex'},record:base},
  {name:'unverified price',record:{...base,pricing_status:'estimated'}},
  {name:'stale official price',record:{...base,pricing_verified_at:new Date(now-25*60*60*1000).toISOString()}},
 ];
 for(const v of variants)assert.throws(()=>allowed(v.evidence??good,v.record??null,v.at??now,v.key??apiKey),
  /TASK4A_MODEL_ELIGIBILITY_UNVERIFIED/,v.name);
});
test('Nonbillable lookup 404, denied request, unavailable model or malformed body all fail closed',async()=>{
 for(const config of [
  {status:404},{status:403},{status:429},
  {body:{object:'model',id:'gpt-6-sol',owned_by:'openai'}},
  {body:{object:'model',id:'gpt-5.3-codex',owned_by:'openai',shutdown_date:'2026-01-01'}},
  {body:{object:'list',id:'gpt-5.3-codex',owned_by:'openai'}},
  {contentType:'text/html'}
 ])await assert.rejects(attest(config),/TASK4A_MODEL_ELIGIBILITY_UNVERIFIED/);
 await assert.rejects(retrieveNativeModelNonbillable({
  apiKey,signingKey,now,fetchImpl:async()=>{throw Error('Synthetic network unavailable')}
 }),/TASK4A_MODEL_ELIGIBILITY_UNVERIFIED/);
});
test('SQL owner proposal, paid decision, grant and each gateway request carry the same fail-closed check',()=>{
 const sql=readFileSync('supabase/migrations/20261105224500_task4a_postpaid_same_task_continuation.sql','utf8');
 const host=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
 assert.match(sql,/task4a_postpaid_model_eligible\(p_release\)/);
 assert.match(sql,/same_github_credential_model_eligibility_required/);
 assert.match(sql,/and public\.task4a_postpaid_model_eligible\(p_release\)/);
 assert.match(sql,/task4a_native_live_pre_postpaid_eligibility/);
 assert.match(sql,/task4a_postpaid_model_eligible\(t\.external->>'developerReleaseSha'\)/);
 assert.match(sql,/capability_status is distinct from 'verified'/);
 assert.match(sql,/routing_eligibility is distinct from 'verified'/);
 assert.match(sql,/credentialBinding/);
 assert.match(host,/retrieveNativeModelNonbillable/);
 assert.match(host,/assertNativeModelEligibility/);
 assert.ok(host.indexOf('retrieveNativeModelNonbillable')<host.indexOf("db.rpc('developer_issue_execution_grant'"),
 'The read-only identity check must happen before the first paid grant');
});
