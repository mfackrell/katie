// Nonbillable real-SDK four-phase acceptance through the same HTTP gateway.
// Qualifies model calls and independently restarted threads, not paid DB recovery.
import {Codex} from '@openai/codex-sdk';
import {createNativeHttpBridge} from './native-http-bridge.mjs';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(tmpdir(),'native-four-phase-'));
const repo=join(root,'repo'),home=join(root,'home'),state=join(home,'.codex');
mkdirSync(repo);mkdirSync(state,{recursive:true});
execFileSync('git',['init','-q',repo]);
const phases=['implementation','review','repair','final-review'];
let forwarded=0;
const admissions=[],receipts=[];
const db={rpc:async(name,args)=>{
 if(name==='benchmark_gateway_execution_live')return {data:true,error:null};
 if(name==='benchmark_full_native_reserve'){
  admissions.push(args);
  return {data:'op-'+admissions.length,error:null};
 }
 throw Error('UNEXPECTED_RPC_'+name);
}};
const server=createNativeHttpBridge({
 db,grantToken:'synthetic-'+('x'.repeat(50)),trialId:'synthetic-trial',
 executionEpoch:1,providerNamespace:'synthetic-four-phase',upperTokens:100,
 clientToken:'synthetic-bridge-token',fullMission:true,
 recordReceipt:async r=>receipts.push(r),
 upstream:async body=>{
  forwarded++;
  const phase=phases[forwarded-1];
  assert.ok(phase,'unexpected extra model call');
  assert.equal(body.model,'synthetic');
  const answer=phase==='review'?'CHANGES_REQUESTED: synthetic fixture requests repair':
   phase==='final-review'?'PASS: synthetic repair accepted':'DONE';
  const item={id:'message_'+forwarded,type:'message',role:'assistant',status:'completed',
   content:[{type:'output_text',text:answer,annotations:[]}]};
  const response={id:'resp_phase_'+forwarded,object:'response',created_at:1,
   model:body.model,status:'completed',output:[item],
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
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port+'/v1';
 writeFileSync(join(state,'config.toml'),'model_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nbase_url = "'+url+'"\nrequest_max_retries = 0\nstream_max_retries = 0\n');
 for(const phase of phases){
  const codex=new Codex({baseUrl:url,apiKey:'synthetic-bridge-token',env:{
   PATH:process.env.PATH||'',HOME:home,CODEX_HOME:state,CODEX_SQLITE_HOME:state,
   CODEX_API_KEY:'synthetic-bridge-token'}});
  const thread=codex.startThread({workingDirectory:repo,skipGitRepoCheck:false,model:'synthetic',
   sandboxMode:phase==='review'||phase==='final-review'?'read-only':'workspace-write'});
  const {events}=await thread.runStreamed('Synthetic acceptance phase: '+phase);
  let completed=false,message='';
  for await(const event of events){
   if(event.type==='turn.completed')completed=true;
   if(event.type==='item.completed'&&event.item?.type==='agent_message')message=event.item.text;
   if(event.type==='turn.failed')throw Error('FOUR_PHASE_TURN_FAILED:'+phase);
  }
  assert.ok(completed,'four-phase turn incomplete: '+phase);
  if(phase==='review')assert.match(message,/CHANGES_REQUESTED/);
  if(phase==='final-review')assert.match(message,/^PASS/);
 }
 assert.equal(forwarded,4,'unexpected SDK inference retries or continuations');
 assert.equal(admissions.length,4,'unmetered phase');
 assert.equal(receipts.length,4,'missing phase receipt');
 assert.equal(new Set(admissions.map(x=>x.p_request_key)).size,4);
 assert.equal(receipts.reduce((n,x)=>n+x.actualTokens,0),20);
 console.log('NATIVE_FOUR_PHASE_METERED_SYNTHETIC_PASS');
}finally{
 await new Promise(resolve=>server.close(resolve));
 rmSync(root,{recursive:true,force:true});
}
