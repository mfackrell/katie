import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {runNonFullAuthorizedHost} from '../scripts/benchmark/nonfull-authorized-host.mjs';
const uuid=i=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0');
const load=f=>readFileSync(f,'utf8');
test('Native and Thin real PostgreSQL grants, reservations, receipts and contained SDK phases',
 {timeout:240000},async t=>{
 const sandboxAvailable=spawnSync('bwrap',['--unshare-user','--ro-bind','/','/','--','/bin/true']).status===0
   && spawnSync('which',['socat']).status===0;
 if(!sandboxAvailable){
   if(process.env.KATIE_REQUIRE_NATIVE_BWRAP==='1')throw Error('REQUIRED_NATIVE_SANDBOX_UNAVAILABLE');
   // General CI validates fail-closed input admission; the dedicated hosted
   // qualification MUST run the complete contained SDK/PostgreSQL test.
   await assert.rejects(runNonFullAuthorizedHost({arm:'native',db:null,workspace:null}),
     /NONFULL_HOST_PAID_EXECUTION_DENIED/);
   return;
 }
 const bin=process.env.KATIE_TEST_PG_BIN||'/usr/lib/postgresql/16/bin';
 const root=mkdtempSync(join(tmpdir(),'native-thin-db-sdk-')),data=join(root,'data');
 let started=false,sql;
 const run=(name,args)=>{
  const p=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});
  assert.equal(p.status,0,p.stderr||p.error?.message);
 };
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(root,'log'),'-o',`-h '' -k ${root} -p 55499`,'-w','start']);started=true;
  sql=new pg.Client({host:root,port:55499,user:'postgres',database:'postgres'});
  await sql.connect();
  for(const path of [
   'tests/sql/benchmark-nonfull-grant-schema.sql',
   'supabase/migrations/20261024211500_record_benchmark_overruns.sql',
   'supabase/migrations/20261024213000_benchmark_provider_receipts.sql',
   'supabase/migrations/20261024220000_benchmark_receipt_quarantine.sql',
   'supabase/migrations/20261025193000_benchmark_execution_grants.sql',
   'supabase/migrations/20261025200000_benchmark_gateway_stop_fence.sql',
   'supabase/migrations/20261025201000_benchmark_atomic_stop_admission.sql',
   'supabase/migrations/20261026130000_benchmark_nonfull_execution_grants.sql'])
   await sql.query(load(path));
  await sql.query('set role service_role');
  const rpc=async(name,args)=>{
   const allowed={
    benchmark_issue_nonfull_execution_grant:[
     'p_owner','p_actor','p_chat','p_trial','p_approval','p_repository','p_model','p_epoch','p_deadline','p_digest'],
    benchmark_gateway_execution_live:['p_digest','p_trial','p_epoch'],
    benchmark_grant_reserve:['p_digest','p_trial','p_epoch','p_request_key','p_model','p_tokens'],
    benchmark_reconcile_receipt:['p_call','p_namespace','p_provider_request','p_actual']
   };
   const fields=allowed[name];
   if(!fields)throw Error('UNEXPECTED_RPC:'+name);
   try{
    const values=fields.map(k=>args[k]);
    const placeholders=values.map((_,i)=>'$'+(i+1)).join(',');
    const result=await sql.query('select '+name+'('+placeholders+') as answer',values);
    return {data:result.rows[0].answer,error:null};
   }catch(error){console.error('DISPOSABLE_PG_RPC_DENIED',name,error.code,String(error.message).slice(0,260));return {data:null,error:{message:error.message}}}
  };
  for(let armIndex=0;armIndex<2;armIndex++){
   const arm=['native','thin'][armIndex];
   const trialId=uuid(10+armIndex*10),accountId=uuid(11+armIndex*10),
    approvalId=uuid(12+armIndex*10),actor=uuid(13),owner=uuid(14),chat=uuid(15);
   const trial={id:trialId,arm,state:'qualified',owner_actor_id:actor,
    experiment_id:uuid(16),replicate:1,baseline_sha:'b'.repeat(40),
    contract_sha256:'c'.repeat(64),acceptance_sha256:'a'.repeat(64),
    tool_profile_sha256:'d'.repeat(64),model_policy_sha256:'e'.repeat(64),
    runtime_sha256:'f'.repeat(64)};
   const account={id:accountId,arm,trial_id:trialId,owner_actor_id:actor,cap_tokens:500};
   const approval={id:approvalId,owner_id:owner,actor_id:actor,chat_id:chat,
    trial_id:trialId,account_id:accountId,repository:'mfackrell/katie',
    model:'synthetic',max_tokens:500,deadline:'2099-01-01T00:00:00Z',
    task_id:null,project_id:null,mission_assignment_id:null};
   approval.protocol_digest=createHash('sha256').update(JSON.stringify({
    experimentId:trial.experiment_id,replicate:1,baselineSha:trial.baseline_sha,
    contractSha256:trial.contract_sha256,acceptanceSha256:trial.acceptance_sha256,
    toolProfileSha256:trial.tool_profile_sha256,
    modelPolicySha256:trial.model_policy_sha256,runtimeSha256:trial.runtime_sha256,
    tokenCap:500
   })).digest('hex');
   await sql.query('insert into benchmark_three_arm_trials values($1,$2,$3,$4)',
    [trialId,arm,'qualified',actor]);
   await sql.query('insert into benchmark_budget_accounts(id,trial_id,arm,owner_actor_id,cap_tokens) values($1,$2,$3,$4,500)',
    [accountId,trialId,arm,actor]);
   await sql.query(`insert into benchmark_native_spending_approvals(
    id,owner_id,actor_id,chat_id,trial_id,account_id,repository,model,
    deadline,max_tokens,protocol_digest)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,500,$10)`,
    [approvalId,owner,actor,chat,trialId,accountId,approval.repository,'synthetic',
     approval.deadline,approval.protocol_digest]);
   const workspace=join(root,'workspace-'+arm);mkdirSync(workspace);
   assert.equal(spawnSync('git',['init','-q',workspace]).status,0);
   mkdirSync(join(workspace,'node_modules'));
   let providerCalls=0;
   const upstream=async body=>{
    providerCalls++;
    const responseText=providerCalls===2?'CHANGES_REQUESTED: fixture':'PASS: fixture';
    const item={id:'message_'+arm+'-'+providerCalls,type:'message',
     role:'assistant',status:'completed',
     content:[{type:'output_text',text:responseText,annotations:[]}]};
    const response={id:'receipt-'+arm+'-'+providerCalls,object:'response',created_at:1,
     model:body.model,status:'completed',output:[item],
     usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
    const events=[
     ['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],
     ['response.output_item.added',{type:'response.output_item.added',output_index:0,item}],
     ['response.output_item.done',{type:'response.output_item.done',output_index:0,item}],
     ['response.completed',{type:'response.completed',response}]
    ];
    return {providerRequestId:response.id,actualTokens:5,contentType:'text/event-stream',
     body:events.map(([kind,value])=>'event: '+kind+'\ndata: '+JSON.stringify(value)+'\n\n').join('')+'data: [DONE]\n\n'};
   };
   upstream.nonbillableFixture=true;
   const result=await runNonFullAuthorizedHost({
    db:{rpc},arm,trial,account,approval,ownerId:owner,repository:'mfackrell/katie',
    workspace,upstream
   });
   assert.equal(result.phases.length,4);
   assert.equal(providerCalls,4);
   const charges=await sql.query(`select count(*)::int n,sum(actual_tokens)::int spent,
    count(distinct provider_request_id)::int receipts from benchmark_budget_calls where account_id=$1`,[accountId]);
   assert.equal(charges.rows[0].n,4);
   assert.equal(charges.rows[0].spent,20);
   assert.equal(charges.rows[0].receipts,4);
   const accountState=await sql.query('select spent_tokens from benchmark_budget_accounts where id=$1',[accountId]);
   assert.equal(Number(accountState.rows[0].spent_tokens),20);
   const auth=await sql.query('select consumed_at from benchmark_native_spending_approvals where id=$1',[approvalId]);
   assert.ok(auth.rows[0].consumed_at);
  }
 }finally{
  if(sql)try{await sql.end()}catch{}
  if(started)try{run('pg_ctl',['-D',data,'-m','immediate','-w','stop'])}catch{}
  rmSync(root,{recursive:true,force:true});
 }
});
