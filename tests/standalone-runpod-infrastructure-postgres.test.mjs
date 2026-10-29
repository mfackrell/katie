import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

test('reviewed Qwen infrastructure reservation, durable job and estimated completion preserve normal accounting', {timeout:120000}, async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||['/usr/lib/postgresql/16/bin','/usr/lib/postgresql/17/bin','/tmp/katie-pg-bin'].find(p=>existsSync(join(p,'initdb')));
 assert.ok(bin,'PostgreSQL initdb/pg_ctl required (set KATIE_TEST_PG_BIN)');
 const dir=mkdtempSync(join(tmpdir(),'standalone-qwen-pg-')),data=join(dir,'data');
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,(r.stderr||r.error?.message||'')+(existsSync(join(dir,'log'))?readFileSync(join(dir,'log'),'utf8'):''));};
 const connections=[];let started=false;
 const connect=async(role)=>{const c=new pg.Client({host:'127.0.0.1',port:55503,user:'postgres',database:'postgres'});await c.connect();connections.push(c);if(role)await c.query('set role '+role);return c;};
 const rpc=async(c,name,args)=>{const keys=Object.keys(args),vals=Object.values(args).map(v=>v&&typeof v==='object'?JSON.stringify(v):v);return (await c.query(`select standalone_${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) value`,vals)).rows[0].value;};
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(dir,'log'),'-o',"-h 127.0.0.1 -k '' -p 55503",'-w','start']);started=true;
  const admin=await connect();
  await admin.query(readFileSync(new URL('./sql/standalone-accounting-schema.sql',import.meta.url),'utf8'));
  for(const file of ['20261028193000_standalone_provider_attempt_ledger.sql','20261029153000_standalone_deleted_scope_history.sql','20261029170000_standalone_pricing_and_enrollment.sql','20261029190000_standalone_actor_authority.sql','20261029200000_standalone_uncertain_exposure_continuation.sql','20261029210000_standalone_qwen_infrastructure.sql'])await admin.query(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  const one=await connect('service_role'),two=await connect('service_role');
  const owner=randomUUID(),other=randomUUID(),actor=randomUUID(),chat=randomUUID();
  await admin.query("insert into actors values($1,'Qwen fixture','standard')",[actor]);
  await admin.query("insert into chats(id,actor_id,title) values($1,$2,'Qwen request')",[chat,actor]);
  await rpc(one,'bind_scope',{p_owner:owner,p_actor:actor,p_chat:chat});
  await admin.query('insert into self_tool_owner_grants(owner_id,actor_id,chat_id) values($1,$2,$3)',[owner,actor,chat]);
  const configure=(call='500000',total='2000000')=>rpc(one,'configure',{p_owner:owner,p_timezone:'America/Chicago',p_call:call,p_request:total});
  let config=await configure();
  const version='standalone-runpod-qwen-still-v1',model='Qwen/Qwen3-VL-8B-Instruct';
  await rpc(one,'register_pricing',{p_version:version,p_metadata:{kind:'reviewed-infrastructure-reservation',model,reservationMicrousd:'20000'}});
  // A current dynamic token catalog has no RunPod row. Only the reviewed policy
  // is exempt from dynamic pricing; ordinary token dispatch remains fenced.
  const dynamicVersion='standalone-catalog-v1-'+'c'.repeat(64);
  await rpc(one,'publish_pricing',{p_version:dynamicVersion,p_metadata:{version:dynamicVersion,currency:'USD',rateUnit:'nanoUSD/token',models:[{provider:'fixture',model:'fixture'}]},p_source_hash:'d'.repeat(64),p_rejected:{}});
  const payload={input:{route:'/v1/chat/completions',method:'POST',body:{model,temperature:0,max_tokens:1400,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/jpeg;base64,aGVsbG8='}},{type:'text',text:'Describe visible contents'}]}]}},policy:{executionTimeout:60000,ttl:900000}};
  const prepared={schemaVersion:'standalone-runpod-still-v1',provider:'runpod',model,endpoint:'/v2/yafwsm98e8m9lv/run',payload,attachmentId:'immutable-attachment',sourceHash:'a'.repeat(64),question:'Describe visible contents',hash:'b'.repeat(64),serializedBody:JSON.stringify(payload)};
  const input=(request,key='attachment-observation:0',extra={})=>({p_owner:owner,p_actor:actor,p_chat:chat,p_request:request,p_key:key,p_hash:prepared.hash,p_payload:prepared,p_pricing:version,p_provider:'runpod',p_model:model,p_reserved:'20000',p_category:'attachment-observation',p_estimate:{status:'estimated',reservationMicrousd:'20000',requestHash:prepared.hash,pricingVersion:version,estimatorVersion:version},p_estimator:version,p_reason:'One bounded Qwen still-image observation',...extra});
  const workflow=request=>({p_owner:owner,p_actor:actor,p_chat:chat,p_request:request,p_hash:'e'.repeat(64),p_body:{request},p_resume:false});
  const getAttempt=(request,key='attachment-observation:0')=>rpc(two,'lookup_attempt',{p_owner:owner,p_request:request,p_key:key});
  const request='known-job-reconnect',wf=workflow(request);
  let lease=await rpc(one,'claim_workflow',wf);
  const attempt=await rpc(one,'admit',input(request));
  assert.equal(attempt.reserved_microusd,'20000');assert.equal(attempt.state,'reserved','reviewed $0.02 is below approved $0.50 per-call threshold');
  assert.equal(String(await rpc(admin,'request_committed',{p_owner:owner,p_request:request})),'20000');
  const claimed=await rpc(one,'claim_dispatch',{p_owner:owner,p_attempt:attempt.id});assert.equal(claimed.state,'dispatched');
  assert.equal(await rpc(two,'claim_dispatch',{p_owner:owner,p_attempt:attempt.id}),null,'a reconnect cannot submit twice');
  await rpc(one,'finish_workflow',{p_owner:owner,p_request:request,p_lease:lease.lease_token,p_status:'paused'});
  assert.equal((await rpc(two,'claim_workflow',{...wf,p_resume:true})).blocked,'unresolved_provider_attempt','unknown accepted-submission identity cannot resubmit or pretend to poll');
  const job='qwen-job-00000001';
  await rpc(one,'record_provider_identifiers',{p_owner:owner,p_attempt:attempt.id,p_request_id:job,p_response_id:null});
  const fresh=await connect('service_role');
  lease=await rpc(fresh,'claim_workflow',{...wf,p_resume:true});assert.equal(lease.claimed,true,'known accepted job can resume only to poll');
  const saved=await getAttempt(request);assert.equal(saved.provider_request_id,job);assert.equal(saved.id,attempt.id);
  assert.equal(await rpc(fresh,'claim_dispatch',{p_owner:owner,p_attempt:attempt.id}),null);
  await rpc(fresh,'mark_uncertain',{p_owner:owner,p_attempt:attempt.id,p_reason:'Polling timed out; accepted job identity retained'});
  await rpc(fresh,'finish_workflow',{p_owner:owner,p_request:request,p_lease:lease.lease_token,p_status:'paused'});
  lease=await rpc(two,'claim_workflow',{...wf,p_resume:true});assert.equal(lease.claimed,true,'poll timeout with known job can reconcile original job');
  await assert.rejects(rpc(one,'admit',input(request,'must-wait-for-job')),/REQUEST_UNCERTAIN/,'new paid work still waits for the unresolved job');
  const jobResult={id:job,status:'COMPLETED',output:{analysis_text:'Observed screenshot text.',coverage:'full'}};
  const checkpoint={status:200,statusText:'OK',headers:[],body:JSON.stringify(jobResult)};
  const evidence={source:'RunPod job status',model,coverage:'full'};
  const finish={p_owner:owner,p_attempt:attempt.id,p_job:job,p_checkpoint:checkpoint,p_evidence:evidence};
  await assert.rejects(rpc(two,'complete_qwen_estimate',{...finish,p_owner:other}),/POLICY_DENIED/);
  await assert.rejects(rpc(two,'complete_qwen_estimate',{...finish,p_job:'different-job-00001'}),/COMPLETION_INVALID/);
  const complete=await rpc(one,'complete_qwen_estimate',finish);
  assert.equal(complete.state,'estimated');assert.equal(complete.actual_microusd,null);assert.equal(complete.provider_receipt_id,null);
  assert.equal(complete.reserved_microusd,'20000');assert.equal(complete.provider_request_id,job);
  assert.equal(complete.evidence.kind,'estimated_infrastructure');assert.equal(complete.evidence.monetaryReceipt,false);
  assert.equal(String(await rpc(admin,'request_committed',{p_owner:owner,p_request:request})),'20000','missing actual cost never becomes zero');
  assert.deepEqual(await rpc(fresh,'complete_qwen_estimate',finish),complete,'idempotent completion reuses original output/job');
  assert.equal(await rpc(fresh,'claim_dispatch',{p_owner:owner,p_attempt:attempt.id}),null,'estimated completion can never submit again');
  await assert.rejects(rpc(fresh,'complete_qwen_estimate',{...finish,p_checkpoint:{...checkpoint,body:JSON.stringify({...jobResult,output:{analysis_text:'conflicting output'}})}}),/CHECKPOINT_CONFLICT/);
  assert.equal((await rpc(two,'finish_workflow',{p_owner:owner,p_request:request,p_lease:lease.lease_token,p_status:'completed',p_result:{observation:'Observed screenshot text.'}})).status,'completed','estimated infrastructure is completed work, not a permanent uncertainty pause');
  assert.equal((await rpc(fresh,'claim_workflow',{...wf,p_resume:true})).claimed,false);
  // Normal per-call and original-request controls remain the final guards.
  config=await configure('10000','30000');
  const threshold=await rpc(one,'admit',input('threshold-proof'));assert.equal(threshold.state,'paused');assert.equal(threshold.pause_reason,'per_call_threshold');
  await rpc(one,'approve',{p_owner:owner,p_attempt:threshold.id,p_hash:threshold.prepared_hash,p_pricing:version,p_revision:config.budget_revision,p_reserved:'20000'});
  assert.equal((await rpc(one,'claim_dispatch',{p_owner:owner,p_attempt:threshold.id})).state,'dispatched','exact owner approval still works');
  config=await configure('500000','30000');
  const totalRequest='cumulative-proof';
  await rpc(one,'admit',input(totalRequest));
  const cumulative=await rpc(one,'admit',input(totalRequest,'attachment-observation:1'));assert.equal(cumulative.state,'paused');assert.equal(cumulative.pause_reason,'request_threshold');
  const bad=await rpc(one,'admit',input('unapproved-endpoint','attachment-observation:0',{p_payload:{...prepared,endpoint:'/v2/unapproved/run'}}));
  await assert.rejects(rpc(one,'claim_dispatch',{p_owner:owner,p_attempt:bad.id}),/INFRASTRUCTURE_POLICY_DENIED/);
  // A terminal failed job retains the estimate but permits one justified escalation.
  config=await configure();
  const failedRequest='terminal-failed-job',failedWf=workflow(failedRequest);
  const failedLease=await rpc(one,'claim_workflow',failedWf);
  const failed=await rpc(one,'admit',input(failedRequest));await rpc(one,'claim_dispatch',{p_owner:owner,p_attempt:failed.id});
  const failedJob='qwen-job-failure-01';
  await rpc(one,'record_provider_identifiers',{p_owner:owner,p_attempt:failed.id,p_request_id:failedJob,p_response_id:null});
  const terminal=await rpc(one,'complete_qwen_estimate',{p_owner:owner,p_attempt:failed.id,p_job:failedJob,p_checkpoint:{status:200,statusText:'OK',headers:[],body:JSON.stringify({id:failedJob,status:'FAILED',error:'worker unavailable'})},p_evidence:{source:'RunPod status'}});
  assert.equal(terminal.state,'estimated');assert.equal(terminal.actual_microusd,null);
  assert.equal((await rpc(one,'finish_workflow',{p_owner:owner,p_request:failedRequest,p_lease:failedLease.lease_token,p_status:'completed'})).status,'completed');
  const emptyRequest='completed-no-output',emptyWf=workflow(emptyRequest),emptyLease=await rpc(one,'claim_workflow',emptyWf);
  const empty=await rpc(one,'admit',input(emptyRequest));await rpc(one,'claim_dispatch',{p_owner:owner,p_attempt:empty.id});
  const emptyJob='qwen-job-empty-0001';await rpc(one,'record_provider_identifiers',{p_owner:owner,p_attempt:empty.id,p_request_id:emptyJob,p_response_id:null});
  const emptyDone=await rpc(one,'complete_qwen_estimate',{p_owner:owner,p_attempt:empty.id,p_job:emptyJob,p_checkpoint:{status:200,statusText:'OK',headers:[],body:JSON.stringify({id:emptyJob,status:'COMPLETED'})},p_evidence:{source:'RunPod status'}});
  assert.equal(emptyDone.state,'estimated');assert.equal(emptyDone.actual_microusd,null,'unusable completed output is terminal estimated cost, never a resume loop');
  assert.equal((await rpc(one,'finish_workflow',{p_owner:owner,p_request:emptyRequest,p_lease:emptyLease.lease_token,p_status:'completed'})).status,'completed');
  // Definitive HTTP rejection permits one justified fallback with retained cost,
  // without fabricating an accepted job ID or attempting the submission again.
  for(const status of [400,401,403,404,422,429]){
   const rejectedRequest='submission-rejection-'+status,rejectedWf=workflow(rejectedRequest);
   const rejectedLease=await rpc(one,'claim_workflow',rejectedWf);
   const rejected=await rpc(one,'admit',input(rejectedRequest));
   await rpc(one,'claim_dispatch',{p_owner:owner,p_attempt:rejected.id});
   const rejectionCheckpoint={status,statusText:'RunPod submission rejected',headers:[],body:JSON.stringify({error:'RunPod submission rejected',status})};
   const rejectedArgs={p_owner:owner,p_attempt:rejected.id,p_checkpoint:rejectionCheckpoint};
   await assert.rejects(rpc(two,'complete_qwen_rejection',{...rejectedArgs,p_owner:other}),/POLICY_DENIED/);
   await assert.rejects(rpc(two,'complete_qwen_rejection',{...rejectedArgs,p_checkpoint:{...rejectionCheckpoint,status:500}}),/REJECTION_INVALID/,'ambiguous server failure cannot be called a definitive rejection');
   const rejection=await rpc(one,'complete_qwen_rejection',rejectedArgs);
   assert.equal(rejection.state,'estimated');assert.equal(rejection.actual_microusd,null);assert.equal(rejection.provider_receipt_id,null);assert.equal(rejection.provider_request_id,null);
   assert.equal(rejection.evidence.submissionStatus,'rejected');assert.equal(rejection.evidence.reservedMicrousd,'20000');
   assert.equal(String(await rpc(admin,'request_committed',{p_owner:owner,p_request:rejectedRequest})),'20000');
   assert.deepEqual(await rpc(two,'complete_qwen_rejection',rejectedArgs),rejection,'exact rejection replay is idempotent');
   assert.equal(await rpc(two,'claim_dispatch',{p_owner:owner,p_attempt:rejected.id}),null,'definitive rejection cannot submit twice');
   await assert.rejects(rpc(two,'complete_qwen_rejection',{...rejectedArgs,p_checkpoint:{...rejectionCheckpoint,body:'conflicting rejection'}}),/CHECKPOINT_CONFLICT/);
   assert.equal((await rpc(one,'finish_workflow',{p_owner:owner,p_request:rejectedRequest,p_lease:rejectedLease.lease_token,p_status:'completed'})).status,'completed','rejected submission cannot permanently block the parent');
  }
  // Only authoritative external reconciliation supplies exact monetary cost.
  const monetary={p_owner:owner,p_attempt:attempt.id,p_provider:'runpod',p_receipt:'authoritative-runpod-invoice-line-1',p_actual:'17000',p_usage:{executionMs:4000},p_evidence:{kind:'verified_monetary_receipt',currency:'USD',invoiceLine:'fixture-authoritative-line'}};
  const settled=await rpc(fresh,'settle',monetary);assert.equal(settled.state,'settled');assert.equal(settled.actual_microusd,'17000');
  assert.deepEqual(await rpc(two,'settle',monetary),settled);
  assert.equal(String(await rpc(admin,'request_committed',{p_owner:owner,p_request:request})),'17000');
  assert.equal((await rpc(two,'settle',{...monetary,p_actual:'18000'})).conflict,true,'late conflicts retain existing receipt behavior');
  assert.equal((await getAttempt(request)).actual_microusd,'17000');
  // A known job is not authority to erase genuine accounting conflicts.
  for(const kind of ['receipt','identifier','usage']){
   let alreadyPaused=false;
   const conflictRequest='unresolved-'+kind,conflictWf=workflow(conflictRequest),conflictLease=await rpc(one,'claim_workflow',conflictWf);
   const conflictAttempt=await rpc(one,'admit',input(conflictRequest));await rpc(one,'claim_dispatch',{p_owner:owner,p_attempt:conflictAttempt.id});
   const conflictJob='qwen-job-conflict-'+kind;
   await rpc(one,'record_provider_identifiers',{p_owner:owner,p_attempt:conflictAttempt.id,p_request_id:conflictJob,p_response_id:null});
   const conflictCheckpoint={status:200,statusText:'OK',headers:[],body:JSON.stringify({id:conflictJob,status:'COMPLETED',output:{analysis_text:'Saved visual evidence'}})};
   const conflictFinish={p_owner:owner,p_attempt:conflictAttempt.id,p_job:conflictJob,p_checkpoint:conflictCheckpoint,p_evidence:{source:'RunPod status'}};
   if(kind==='receipt'){
    await rpc(one,'complete_qwen_estimate',conflictFinish);
    assert.equal((await rpc(one,'settle',{...monetary,p_attempt:conflictAttempt.id})).conflict,true,'a monetary receipt cannot belong to two attempts');
   }else if(kind==='identifier'){
    assert.equal((await rpc(one,'record_provider_identifiers',{p_owner:owner,p_attempt:conflictAttempt.id,p_request_id:'different-job-conflict',p_response_id:null})).conflict,true);
    await rpc(one,'checkpoint_response',{p_owner:owner,p_attempt:conflictAttempt.id,p_checkpoint:conflictCheckpoint});
    const beforeMark=(await admin.query('select to_jsonb(a) row from standalone_provider_attempts a where id=$1',[conflictAttempt.id])).rows[0].row;
    assert.equal(beforeMark.state,'dispatched','identifier conflict can precede the adapter uncertainty transition');
    await assert.rejects(rpc(two,'complete_qwen_estimate',conflictFinish),/INFRASTRUCTURE_CONFLICT/,'crash before mark_uncertain cannot erase identifier conflict');
    assert.deepEqual((await admin.query('select to_jsonb(a) row from standalone_provider_attempts a where id=$1',[conflictAttempt.id])).rows[0].row,beforeMark);
    await rpc(one,'finish_workflow',{p_owner:owner,p_request:conflictRequest,p_lease:conflictLease.lease_token,p_status:'paused'});alreadyPaused=true;
    assert.equal((await rpc(two,'claim_workflow',{...conflictWf,p_resume:true})).blocked,'unresolved_provider_attempt','known job cannot reopen workflow during crash window');
    await rpc(one,'mark_uncertain',{p_owner:owner,p_attempt:conflictAttempt.id,p_reason:'Conflicting provider identity'});
    await rpc(one,'checkpoint_response',{p_owner:owner,p_attempt:conflictAttempt.id,p_checkpoint:conflictCheckpoint});
   }else{
    await rpc(one,'record_partial_usage',{p_owner:owner,p_attempt:conflictAttempt.id,p_usage:{inputTokens:1},p_evidence:{source:'fixture usage'}});
    assert.equal((await rpc(one,'record_partial_usage',{p_owner:owner,p_attempt:conflictAttempt.id,p_usage:{inputTokens:2},p_evidence:{source:'conflicting fixture usage'}})).conflict,true);
    await rpc(one,'checkpoint_response',{p_owner:owner,p_attempt:conflictAttempt.id,p_checkpoint:conflictCheckpoint});
   }
   const raw=async()=> (await admin.query('select to_jsonb(a) row from standalone_provider_attempts a where id=$1',[conflictAttempt.id])).rows[0].row;
   const beforeConflictRetry=await raw();assert.equal(beforeConflictRetry.state,'uncertain');
   await assert.rejects(rpc(two,'complete_qwen_estimate',conflictFinish),/INFRASTRUCTURE_CONFLICT/);
   assert.deepEqual(await raw(),beforeConflictRetry,'completion retry preserves conflict state, evidence and reservation');
   if(!alreadyPaused)assert.equal((await rpc(one,'finish_workflow',{p_owner:owner,p_request:conflictRequest,p_lease:conflictLease.lease_token,p_status:'completed'})).status,'paused');
   assert.equal((await rpc(two,'claim_workflow',{...conflictWf,p_resume:true})).blocked,'unresolved_provider_attempt','known job cannot bypass unacknowledged accounting conflict');
   await rpc(one,'accept_uncertain_exposure',{p_owner:owner,p_attempt:conflictAttempt.id,p_revision:config.budget_revision,p_reserved:'20000'});
   const acceptedLease=await rpc(two,'claim_workflow',{...conflictWf,p_resume:true});assert.equal(acceptedLease.claimed,true,'owner may continue from saved evidence without resolving the charge');
   await assert.rejects(rpc(two,'complete_qwen_estimate',conflictFinish),/INFRASTRUCTURE_CONFLICT/,'owner acknowledgement cannot reclassify or settle conflicting evidence');
   assert.deepEqual(await raw(),beforeConflictRetry);
   assert.equal(String(await rpc(admin,'request_committed',{p_owner:owner,p_request:conflictRequest})),'20000');
   assert.equal((await rpc(two,'finish_workflow',{p_owner:owner,p_request:conflictRequest,p_lease:acceptedLease.lease_token,p_status:'completed'})).status,'completed');
  }
  const estimatedConflictRequest='estimated-identifier-conflict',estimatedConflictWf=workflow(estimatedConflictRequest),estimatedConflictLease=await rpc(one,'claim_workflow',estimatedConflictWf);
  const estimatedConflict=await rpc(one,'admit',input(estimatedConflictRequest));await rpc(one,'claim_dispatch',{p_owner:owner,p_attempt:estimatedConflict.id});
  const estimatedConflictJob='qwen-estimated-conflict-job';await rpc(one,'record_provider_identifiers',{p_owner:owner,p_attempt:estimatedConflict.id,p_request_id:estimatedConflictJob,p_response_id:null});
  const estimatedFinish={p_owner:owner,p_attempt:estimatedConflict.id,p_job:estimatedConflictJob,p_checkpoint:{status:200,statusText:'OK',headers:[],body:JSON.stringify({id:estimatedConflictJob,status:'COMPLETED',output:{analysis_text:'Persisted completed observation'}})},p_evidence:{source:'RunPod status'}};
  await rpc(one,'complete_qwen_estimate',estimatedFinish);
  assert.equal((await rpc(one,'record_provider_identifiers',{p_owner:owner,p_attempt:estimatedConflict.id,p_request_id:'different-estimated-job',p_response_id:null})).conflict,true);
  const beforeEstimatedReplay=await getAttempt(estimatedConflictRequest);assert.equal(beforeEstimatedReplay.state,'estimated');
  await assert.rejects(rpc(two,'complete_qwen_estimate',estimatedFinish),/INFRASTRUCTURE_CONFLICT/,'estimated replay must surface new conflicting evidence');
  assert.deepEqual(await getAttempt(estimatedConflictRequest),beforeEstimatedReplay);
  assert.equal(await rpc(two,'claim_dispatch',{p_owner:owner,p_attempt:estimatedConflict.id}),null);
  await rpc(one,'finish_workflow',{p_owner:owner,p_request:estimatedConflictRequest,p_lease:estimatedConflictLease.lease_token,p_status:'completed'});
  const rejectionConflictRequest='rejection-receipt-conflict',rejectionConflictWf=workflow(rejectionConflictRequest),rejectionConflictLease=await rpc(one,'claim_workflow',rejectionConflictWf);
  const rejectionConflict=await rpc(one,'admit',input(rejectionConflictRequest));await rpc(one,'claim_dispatch',{p_owner:owner,p_attempt:rejectionConflict.id});
  const rejectionCheckpoint={status:400,statusText:'Rejected',headers:[],body:'Submission rejected'};
  const rejectionArgs={p_owner:owner,p_attempt:rejectionConflict.id,p_checkpoint:rejectionCheckpoint};
  await rpc(one,'complete_qwen_rejection',rejectionArgs);
  assert.equal((await rpc(one,'settle',{...monetary,p_attempt:rejectionConflict.id})).conflict,true);
  const beforeRejectionRetry=await getAttempt(rejectionConflictRequest);assert.equal(beforeRejectionRetry.state,'uncertain');
  await assert.rejects(rpc(two,'complete_qwen_rejection',rejectionArgs),/INFRASTRUCTURE_CONFLICT/);
  assert.deepEqual(await getAttempt(rejectionConflictRequest),beforeRejectionRetry,'rejection replay cannot erase monetary conflict');
  await rpc(one,'finish_workflow',{p_owner:owner,p_request:rejectionConflictRequest,p_lease:rejectionConflictLease.lease_token,p_status:'paused'});
  const snapshot=await rpc(two,'snapshot',{p_owner:owner});assert.ok(snapshot.attempts.some(a=>a.id===failed.id&&a.state==='estimated'&&a.actual_microusd===null));
  assert.equal((await admin.query('select spent_tokens from benchmark_budget_accounts')).rows[0].spent_tokens,'731','Developer Orchestrator accounting unchanged');
  await one.query('set role authenticated');await assert.rejects(rpc(one,'complete_qwen_estimate',finish),/permission denied/);
  await assert.rejects(rpc(one,'complete_qwen_rejection',{p_owner:owner,p_attempt:attempt.id,p_checkpoint:{}}),/permission denied/);
  console.log('STANDALONE_QWEN_REVIEWED_INFRASTRUCTURE_POLICY_DURABLE_JOB_AND_ESTIMATE_PASS');
 }finally{
  await Promise.allSettled(connections.map(c=>c.end()));
  if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
 }
});
