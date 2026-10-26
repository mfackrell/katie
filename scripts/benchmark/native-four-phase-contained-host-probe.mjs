// True contained four-phase SDK qualification with a separate trusted Unix
// socket gateway. All responses are synthetic and cannot incur model charges.
import {createNativeHttpBridge} from './native-http-bridge.mjs';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(tmpdir(),'four-phase-contained-'));
const workRoot=join(root,'workspaces'),socketdir=join(root,'socket'),socket=join(socketdir,'gateway.sock');
mkdirSync(workRoot);mkdirSync(socketdir);
for(const id of ['native','thin','full']){const dir=join(workRoot,id);mkdirSync(dir);execFileSync('git',['init','-q',dir]);}
const phases=['implementation','review','repair','final-review'];
const requestedArm=process.env.KATIE_TRIAL_ARM;
if(requestedArm&& !['native','thin'].includes(requestedArm))throw Error('NONFULL_ARM_REQUIRED');
const selectedArms=requestedArm?[requestedArm]:['native','thin','full'];
const manifestPath=process.env.KATIE_TRIAL_MANIFEST;
let boundTrialId='synthetic-trial';
if(requestedArm){
 if(!manifestPath)throw Error('NONFULL_LAUNCH_MANIFEST_REQUIRED');
 const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
 if(manifest.arm!==requestedArm||manifest.qualification!=='nonbillable-only'||
    manifest.requiresNewGrantBeforePaidExecution!==true||
    typeof manifest.trialId!=='string'||!manifest.trialId||
    typeof manifest.accountId!=='string'||!manifest.accountId||
    typeof manifest.approvalId!=='string'||!manifest.approvalId)
  throw Error('NONFULL_LAUNCH_IDENTITY_MISMATCH');
 boundTrialId=manifest.trialId;
}
let phase=null,arm=null,forwarded=0;
const reservations=[],receipts=[];
const db={rpc:async(name,args)=>{
 if(name==='benchmark_gateway_execution_live')return {data:true,error:null};
 if(name==='benchmark_full_native_reserve'){
  reservations.push(args);
  return {data:'synthetic-operation-'+reservations.length,error:null};
 }
 throw Error('UNEXPECTED_RPC_'+name);
}};
const server=createNativeHttpBridge({
 db,grantToken:'synthetic-'+('z'.repeat(60)),trialId:boundTrialId,
 executionEpoch:1,providerNamespace:'synthetic',upperTokens:100,fullMission:true,
 clientToken:'contained-fixture-token',recordReceipt:async r=>receipts.push(r),
 upstream:async request=>{
  forwarded++;
  assert.equal(phases[(forwarded-1)%4],phase,'unexpected SDK retry or continuation');
  const verdict=phase==='review'?'CHANGES_REQUESTED: synthetic defect':
   phase==='final-review'?'PASS: synthetic repair verified':'DONE';
  const item={id:'msg_'+forwarded,type:'message',role:'assistant',status:'completed',
   content:[{type:'output_text',text:verdict,annotations:[]}]};
  const response={id:'synthetic-response-'+forwarded,object:'response',created_at:1,
   model:request.model,status:'completed',output:[item],
   usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
  const events=[
   ['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],
   ['response.output_item.added',{type:'response.output_item.added',output_index:0,item}],
   ['response.output_item.done',{type:'response.output_item.done',output_index:0,item}],
   ['response.completed',{type:'response.completed',response}]
  ];
  return {providerRequestId:response.id,actualTokens:5,contentType:'text/event-stream',
   body:events.map(([event,data])=>'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n').join('')+'data: [DONE]\n\n'};
 }
});
try{
 await new Promise(resolve=>server.listen(socket,resolve));
 for(const nextArm of selectedArms){
  arm=nextArm;
 for(const next of phases){
  phase=next;
  const reviewing=phase==='review'||phase==='final-review';
  const command='socat TCP-LISTEN:43181,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/gateway/gateway.sock & proxy=$!; trap "kill $proxy 2>/dev/null || :" EXIT; node /app/scripts/benchmark/native-four-phase-contained-client.mjs';
  const args=['--die-with-parent','--new-session','--unshare-all','--clearenv',
   '--ro-bind','/usr','/usr','--ro-bind','/bin','/bin',
   '--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64',
   '--ro-bind','/opt','/opt','--ro-bind',process.cwd(),'/app',
   reviewing?'--ro-bind':'--bind',join(workRoot,arm),'/work',
   '--bind',socketdir,'/gateway','--tmpfs','/tmp','--proc','/proc','--dev','/dev',
   '--setenv','HOME','/tmp/contained','--setenv','CODEX_HOME','/tmp/contained/.codex',
   '--setenv','PATH',process.env.PATH||'/usr/bin:/bin',
   '--setenv','KATIE_NATIVE_PHASE',phase,
   '--setenv','KATIE_BENCHMARK_ARM',arm,
   '--setenv','KATIE_OUTER_SANDBOX_CONFIRMED','1',
   '--chdir','/app','/bin/sh','-c',command];
  const child=spawn('bwrap',args,{env:{PATH:process.env.PATH||''}});
  let output='',errors='';
  child.stdout.on('data',x=>output+=x);
  child.stderr.on('data',x=>errors+=x);
  const code=await new Promise((resolve,reject)=>{
   child.once('error',reject);
   child.once('close',resolve);
  });
  assert.equal(code,0,phase+':'+errors+'\n'+output);
  assert.match(output,new RegExp('CONTAINED_PHASE_PASS='+phase));
 }
 }
 assert.equal(forwarded,selectedArms.length*4);
 assert.equal(reservations.length,selectedArms.length*4,'unmetered native phase');
 assert.equal(receipts.length,selectedArms.length*4,'unreconciled native phase');
 assert.equal(new Set(reservations.map(x=>x.p_request_key)).size,selectedArms.length*4);
 assert.equal(receipts.reduce((n,x)=>n+x.actualTokens,0),selectedArms.length*20);
 console.log(requestedArm?'NONFULL_OWNER_APPROVED_SYNTHETIC_LAUNCH_PASS:'+requestedArm:'NATIVE_THIN_FULL_SHARED_CONTAINED_PHASES_PASS');
}finally{
 await new Promise(resolve=>server.close(resolve));
 rmSync(root,{recursive:true,force:true});
}
