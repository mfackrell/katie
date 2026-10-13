import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import crypto from 'node:crypto';
import ts from 'typescript';
const r={actor_id:'actor',chat_id:'chat',assistant_id:'assistant',attachment_id:'clip',started_at:'2026-10-13T00:00:00Z',deadline_at:'2099-10-13T00:20:00Z',cleaned_at:null};
function harness(fault='', slot='wp4') {
  let claimed=false, submissions=0, uploads=0;
  const removals=[];
  const record=fault==='cleanup'?{...r,deadline_at:new Date(Date.now()-60_000).toISOString()}:r;
  const env={RUNPOD_SYNTHETIC_VALIDATION_SLOT:slot,RUNPOD_INTERNAL_TOKEN:'a'.repeat(32),SUPABASE_URL:'https://mock.invalid',SUPABASE_SERVICE_ROLE_KEY:'mock'};
  const db={rpc:async name=>{
    if(name==='cleanup_runpod_synthetic_validation'+(slot==='wp4-retest'?'_retest':'')) return {};
    assert.equal(name,'claim_runpod_synthetic_validation'+(slot==='wp4-retest'?'_retest':''));
    if (claimed) return {data:null};
    claimed=true; return {data:fault==='slow_setup'?{...r,deadline_at:new Date(Date.now()+17*60_000).toISOString()}:r};
  },from:table=>{
    assert.equal(table,'runpod_synthetic_validation');
    const q={select:()=>q,eq:(key,value)=>{assert.equal(key,'slot');assert.equal(value,slot);return q;},maybeSingle:async()=>({data:record})};return q;
  },storage:{from:()=>({remove:async paths=>{removals.push(...paths);return {};},upload:async()=>{uploads++;return fault==='upload'?{error:true}:{};}})}};
  const exports={};
  vm.runInNewContext(ts.transpileModule(readFileSync('lib/runpod/synthetic-validation.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports,process:{env,cwd:()=>'.'},Buffer,Date,require:name=>{
      if(name==='node:crypto') return crypto;
      if(name==='node:path') return {join:(...xs)=>xs.join('/')};
      if(name==='node:fs/promises') return {readFile:async()=>fault==='fixture'?Buffer.from('bad'):readFileSync('fixtures/runpod/synthetic-red-blue.mp4')};
      if(name==='@supabase/supabase-js') return {createClient:()=>db};
      if(name==='./durable-results') return {assertRunpodAdmin:req=>req.headers.get('x-runpod-admin-token')===env.RUNPOD_INTERNAL_TOKEN,
        submitSavedVideo:async p=>{submissions++;assert.equal(p.requestId,`synthetic-${slot}`);assert.equal(p.syntheticValidation,true);assert.equal(p.videoTotal,1);assert.equal(p.actorId,r.actor_id);
          if(fault==='submit') throw new Error('secret');return {id:'receipt',status:fault==='uncertain'?'pending':'queued'};}};
      throw new Error(name);
    }});
  return {exports,env,removals,get submissions(){return submissions;},get uploads(){return uploads;}};
}
test('synthetic harness is off by default and authenticates every action',()=>{
  const h=harness();const authorized=new Request('https://mock.invalid',{headers:{'x-runpod-admin-token':'a'.repeat(32)}});
  assert.equal(h.exports.syntheticAccess(new Request('https://mock.invalid')),401);
  assert.equal(h.exports.syntheticAccess(authorized),404);
  h.env.RUNPOD_SYNTHETIC_VALIDATION_ENABLED='true';assert.equal(h.exports.syntheticAccess(authorized),null);
});
test('concurrent and retried triggers reserve one clip and one submission',async()=>{
  for(const fault of ['', 'uncertain','submit','upload']) {
    const h=harness(fault);
    await Promise.allSettled([h.exports.startSyntheticValidation(),h.exports.startSyntheticValidation()]);
    const retry=await h.exports.startSyntheticValidation();
    assert.equal(retry.status,'already_claimed');assert.equal(h.uploads,fault==='upload'?1:2);assert.equal(h.submissions,fault==='upload'?0:1);
  }
});
test('corrupt fixture fails before claim or upload',async()=>{
  const h=harness('fixture');await assert.rejects(h.exports.startSyntheticValidation(),/fixture_invalid/);assert.equal(h.uploads,0);assert.equal(h.submissions,0);
});
test('delivery requires isolated evidence and never claims callback/live pass from POST or polling',()=>{
  const h=harness();const j={id:'receipt',actor_id:r.actor_id,chat_id:r.chat_id,target_chat_id:r.chat_id,assistant_message_id:r.assistant_id,
    attachment_path:'chats/chat/clip.source',status:'completed',analysis_text:'private analysis',fallback_text:'private fallback',fallback_state:'completed',response_delivered_at:'now'};
  const m={id:r.assistant_id,actor_id:r.actor_id,chat_id:r.chat_id,content:'A white square on red then blue.'};
  const summary=(jobs=[j],messages=[m],source=true)=>h.exports.summarizeSynthetic(r,jobs,messages,source,Date.parse(r.started_at));
  assert.equal(summary().status,'pipeline_pass');assert.equal(summary().livePass,false);assert.equal(summary().callbackProvenance,'not_observed');
  const marked={...r,callback_received_at:'now',callback_receipt_id:'receipt',callback_provider_id:'provider-123'};
  assert.equal(h.exports.summarizeSynthetic(marked,[{...j,runpod_job_id:'provider-123'}],[m],true,Date.parse(r.started_at)).livePass,true);
  assert.equal(h.exports.summarizeSynthetic(marked,[{...j,runpod_job_id:'wrong'}],[m],true,Date.parse(r.started_at)).livePass,false);
  assert.equal(summary([{...j,status:'queued'}]).status,'pending');
  assert.equal(summary([{...j,actor_id:'other'}]).isolated,false);
  assert.equal(summary([j,j]).isolated,false);
  assert.equal(summary([j],[m,{...m,id:'other'}]).isolated,false);
  assert.equal(summary([j],[m],false).status,'pending');
  assert.equal(summary([j],[{...m,content:'Something happened'}]).status,'pending');
  assert.ok(!JSON.stringify(summary()).includes('private'));
});
test('singleton SQL grants no public execution and retains claim through cleanup',()=>{
  const sql=readFileSync('supabase/migrations/202610130005_runpod_synthetic_validation.sql','utf8');
  assert.match(sql,/on conflict do nothing returning/);assert.match(sql,/enable row level security/);
  assert.doesNotMatch(sql,/delete from public.runpod_synthetic_validation/);
  assert.match(sql,/revoke all on function public.claim_runpod_synthetic_validation\(\) from public, anon, authenticated/);
});
test('GET POST DELETE routes reject unauthorized/default-off calls and redact faults',async()=>{
  let denied=401,calls=0;
  const exports={};
  const action=async()=>{calls++;throw new Error('signed-url-secret');};
  vm.runInNewContext(ts.transpileModule(readFileSync('app/api/internal/runpod-results/synthetic/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports,require:name=>name==='next/server'?{NextResponse:{json:(body,init)=>Response.json(body,init)}}:
      {syntheticAccess:()=>denied,startSyntheticValidation:action,syntheticStatus:action,cleanupSyntheticValidation:action}});
  for(const method of ['GET','POST','DELETE']) {
    denied=401;assert.equal((await exports[method]({})).status,401);
    denied=404;assert.equal((await exports[method]({})).status,404);
  }
  assert.equal(calls,0);
  denied=null;
  for(const method of ['GET','POST','DELETE']) {
    const response=await exports[method]({});assert.equal(response.status,503);
    assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(!(await response.text()).includes('secret'));
  }
  assert.equal(calls,3);
});

test('allowlisted retest uses a new permanent claim and correlation; unknown server slots fail closed',async()=>{
  for(const fault of ['', 'uncertain','submit','upload']) {
    const h=harness(fault,'wp4-retest');
    await Promise.allSettled([h.exports.startSyntheticValidation(),h.exports.startSyntheticValidation()]);
    assert.equal((await h.exports.startSyntheticValidation()).status,'already_claimed');
    assert.equal(h.submissions,fault==='upload'?0:1);
  }
  const h=harness('','arbitrary');
  await assert.rejects(h.exports.startSyntheticValidation(),/invalid_slot/);
  assert.equal(h.submissions,0);assert.equal(h.uploads,0);
});

test('slow setup consumes the new claim without POST rather than losing delivery margin',async()=>{
  const h=harness('slow_setup','wp4-retest');
  await assert.rejects(h.exports.startSyntheticValidation(),/deadline_exceeded/);
  assert.equal(h.submissions,0);assert.equal((await h.exports.startSyntheticValidation()).status,'already_claimed');
});

test('retest cleanup deletes only its private source and metadata and refuses early cleanup',async()=>{
  const active=harness('','wp4-retest');
  await assert.rejects(active.exports.cleanupSyntheticValidation(),/still_active/);
  assert.equal(active.removals.length,0);
  const h=harness('cleanup','wp4-retest');
  assert.equal((await h.exports.cleanupSyntheticValidation()).status,'cleaned');
  assert.deepEqual(h.removals,['chats/chat/clip.source','chats/chat/clip.json']);
  assert.equal(h.submissions,0);
});
