// Synthetic protected host: real Codex process in bwrap talks ONLY to a
// Unix-socket gateway outside its network namespace (via internal loopback).
// This qualifies topology, not production billing or provider authorization.
import {createNativeHttpBridge} from './native-http-bridge.mjs';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(tmpdir(),'gateway-host-'));
const work=join(root,'repo'),socketdir=join(root,'socket'),socket=join(socketdir,'gateway.sock');
mkdirSync(work);mkdirSync(socketdir);
execFileSync('git',['init','-q',work]);
let provider=0;const admissions=[],receipts=[];
const db={rpc:async(name,args)=>{
 if(name==='benchmark_gateway_execution_live')return{data:true,error:null};
 if(name==='benchmark_grant_reserve'){admissions.push(args);return{data:'op-'+admissions.length,error:null};}
 throw Error('UNEXPECTED_DB_RPC');
}};
const server=createNativeHttpBridge({db,grantToken:'only-synthetic-'+('z'.repeat(64)),
 trialId:'synthetic-trial',executionEpoch:1,providerNamespace:'synthetic',
 upperTokens:100,clientToken:'synthetic-fixture-token',
 recordReceipt:async x=>receipts.push(x),
 upstream:async body=>{
  provider++;
  const first=provider===1,model=body.model||'synthetic';
  const item=first?{id:'call_'+provider,type:'custom_tool_call',name:'exec',
   call_id:'call_tool_1',input:'const r=await tools.exec_command({cmd:"printf NATIVE_TOOL_OK > native-tool.txt && test -s native-tool.txt",workdir:"/work"});text(r);',
   status:'completed'}:{id:'message_'+provider,type:'message',role:'assistant',
   status:'completed',content:[{type:'output_text',text:'DONE',annotations:[]}]};
  const response={id:'synthetic-response-'+provider,object:'response',created_at:1,
   model,status:'completed',output:[item],usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
  const events=[['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],
  ['response.output_item.added',{type:'response.output_item.added',output_index:0,item}],
  ['response.output_item.done',{type:'response.output_item.done',output_index:0,item}],
  ['response.completed',{type:'response.completed',response}]];
  const bodyText=events.map(([name,data])=>'event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n').join('')+'data: [DONE]\n\n';
  return {providerRequestId:response.id,actualTokens:5,body:bodyText,contentType:'text/event-stream'};
 }});
try{
 await new Promise(resolve=>server.listen(socket,resolve));
 const command='socat TCP-LISTEN:43181,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/gateway/gateway.sock & proxy=$!; trap "kill $proxy 2>/dev/null || :" EXIT; node scripts/benchmark/external-native-codex-client.mjs';
 const args=['--die-with-parent','--new-session','--unshare-all',
 '--ro-bind','/usr','/usr','--ro-bind','/bin','/bin',
 '--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64',
 '--ro-bind','/opt','/opt','--ro-bind',process.cwd(),'/app',
 '--bind',work,'/work','--bind',socketdir,'/gateway',
 '--tmpfs','/tmp','--proc','/proc','--dev','/dev',
 '--setenv','HOME','/tmp/home','--setenv','CODEX_HOME','/tmp/home/.codex',
 '--setenv','KATIE_TEST_REPO','/work','--setenv','KATIE_TEST_GATEWAY_PORT','43181',
 '--setenv','KATIE_OUTER_SANDBOX_CONFIRMED','1',
 '--setenv','OPENAI_API_KEY','','--setenv','CODEX_ACCESS_TOKEN','',
 '--chdir','/app','/bin/sh','-c',command];
 const child=spawn('bwrap',args,{env:{PATH:process.env.PATH||''}});
 let output='',error='';
 child.stdout.on('data',x=>output+=x);
 child.stderr.on('data',x=>error+=x);
 const exit=await new Promise(resolve=>child.on('close',resolve));
 assert.equal(exit,0,error+'\n'+output);
 assert.match(output,/EXTERNAL_NATIVE_SDK_TOOL_PASS/);
 assert.equal(provider,2,'unexpected native provider request count');
 assert.equal(admissions.length,provider,'unmetered native request');
 assert.equal(receipts.length,provider,'missing provider receipt');
 assert.equal(readFileSync(join(work,'native-tool.txt'),'utf8'),'NATIVE_TOOL_OK');
 console.log(JSON.stringify({proof:'HOST_ISOLATED_UNIX_GATEWAY_PASS',
  providerRequests:provider,admissions:admissions.length,receipts:receipts.length}));
}finally{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});}
