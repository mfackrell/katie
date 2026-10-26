// Real SDK + HTTP bridge qualification. Synthetic transport; no paid credentials.
import {Codex} from '@openai/codex-sdk';
import {createNativeHttpBridge} from './native-http-bridge.mjs';
import {mkdtempSync,mkdirSync,readFileSync,existsSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(tmpdir(),'native-bridge-sdk-'));
const repo=join(root,'repo'),home=join(root,'home'),codexHome=join(home,'.codex');
mkdirSync(repo);mkdirSync(codexHome,{recursive:true});
execFileSync('git',['init','-q',repo]);
const admitted=[],receipts=[];let providerRequests=0;
const db={rpc:async(name,args)=>{
 if(name==='benchmark_gateway_execution_live')return {data:true,error:null};
 if(name==='benchmark_grant_reserve'){admitted.push(args);return {data:'op-'+admitted.length,error:null};}
 throw Error('UNEXPECTED_RPC_'+name);
}};
const server=createNativeHttpBridge({
 db,grantToken:'only-synthetic-'+('z'.repeat(64)),trialId:'trial-synthetic',executionEpoch:1,
 providerNamespace:'local-synthetic',upperTokens:100,clientToken:'synthetic-only',
 recordReceipt:async x=>{receipts.push(x);},
 upstream:Object.assign(async body=>{
  providerRequests++;
  const first=providerRequests===1;
  const model=body.model||'synthetic';
  const item=first?{
   id:'call_shell_1',type:'custom_tool_call',name:'exec',call_id:'call_test_1',
   input:'const r=await tools.exec_command({cmd:"printf NATIVE_TOOL_OK > native-tool.txt && test -s native-tool.txt",workdir:"'+repo+'"});text(r);',
   status:'completed'
  }:{
   id:'msg_'+providerRequests,type:'message',role:'assistant',status:'completed',
   content:[{type:'output_text',text:'NATIVE_TOOL_DONE',annotations:[]}]
  };
  const response={id:'resp_synthetic_'+providerRequests,object:'response',
   created_at:1,model,status:'completed',output:[item],
   usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
  const events=[
   ['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],
   ['response.output_item.added',{type:'response.output_item.added',output_index:0,item}],
   ['response.output_item.done',{type:'response.output_item.done',output_index:0,item}],
   ['response.completed',{type:'response.completed',response}]
  ];
  const sse=events.map(([type,payload])=>'event: '+type+'\ndata: '+JSON.stringify(payload)+'\n\n').join('')+'data: [DONE]\n\n';
  return {providerRequestId:'synthetic-request-'+providerRequests,actualTokens:5,
   body:sse,contentType:'text/event-stream'};
 },{nonbillableFixture:true})
});
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port+'/v1';
 writeFileSync(join(codexHome,'config.toml'),'model_provider = "synthetic_http"\n[model_providers.synthetic_http]\nname = "Synthetic HTTP"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nbase_url = "'+url+'"\nrequest_max_retries = 0\nstream_max_retries = 0\n');
 const codex=new Codex({baseUrl:url,apiKey:'synthetic-only',env:{
  PATH:process.env.PATH||'',HOME:home,CODEX_HOME:codexHome,CODEX_SQLITE_HOME:codexHome,
  CODEX_API_KEY:'synthetic-only'
 }});
 const thread=codex.startThread({workingDirectory:repo,skipGitRepoCheck:false,
  sandboxMode:process.env.KATIE_OUTER_SANDBOX_CONFIRMED==='1'?'danger-full-access':'workspace-write'});
 let completed=false;
 const {events}=await thread.runStreamed('Use a shell tool to create native-tool.txt with NATIVE_TOOL_OK, verify it, then finish.');
 for await(const event of events){if(event.type==='turn.completed')completed=true;}
 assert(completed,'SDK_TURN_INCOMPLETE');
 assert(existsSync(join(repo,'native-tool.txt')),'NATIVE_EDIT_NOT_EXECUTED');
 assert.equal(readFileSync(join(repo,'native-tool.txt'),'utf8'),'NATIVE_TOOL_OK');
 assert(providerRequests>=2,'MODEL_NOT_RESUMED_AFTER_TOOL');
 assert.equal(admitted.length,providerRequests,'UNMETERED_REQUEST');
 assert.equal(receipts.length,providerRequests,'UNRECONCILED_REQUEST');
 assert.equal(new Set(admitted.map(x=>x.p_request_key)).size,providerRequests);
 console.log(JSON.stringify({qualification:'NATIVE_SDK_GATEWAY_REAL_HTTP_PASS',
  requests:providerRequests,reservations:admitted.length,receipts:receipts.length,
  actualTokens:receipts.reduce((s,x)=>s+x.actualTokens,0)}));
}finally{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});}
