// Run the actual production child and model configuration through the real paid
// admission path. The isolated gateway has ONLY in-memory DB/synthetic responses.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createNativeHttpBridge} from './native-http-bridge.mjs';
import {sharedNativeContainerArgs} from './shared-native-container.mjs';
import {assertTrustedBoundary,protectedNativeMounts} from './native-trust-boundary.mjs';
const root=mkdtempSync(join(tmpdir(),'actual-native-child-'));
const work=join(root,'work'),socketDir=join(root,'socket'),socket=join(socketDir,'gateway.sock');
mkdirSync(work);mkdirSync(socketDir);mkdirSync(join(work,'node_modules'));
execFileSync('git',['init','-q',work]);
execFileSync('git',['-C',work,'-c','user.name=Synthetic probe','-c','user.email=probe@example.invalid','commit','--allow-empty','-qm','Synthetic baseline']);
const baseline=execFileSync('git',['-C',work,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
writeFileSync(join(root,'AGENT_REQUEST.md'),'Synthetic nonbillable qualification. Reply DONE. No repository changes.');
writeFileSync(join(root,'review-findings.txt'),'Synthetic defect: require final independent review.');
const phases=['implementation','review','repair','final-review'];
const token='synthetic-bridge-token-not-a-provider-credential';
const calls=[],receipts=[],summaries=[];let phase='',forwarded=0;
const db={rpc:async(name,args)=>{
 calls.push({name,args});
 if(name==='benchmark_gateway_execution_live')return {data:true,error:null};
 if(name==='benchmark_full_native_reserve')return {data:'synthetic-operation-'+calls.length,error:null};
 throw Error('UNEXPECTED_PROBE_RPC:'+name);
}};
// Deliberately DO NOT set upstream.nonbillableFixture: it bypasses the actual
// request-shape and byte-bound admission checks that this probe must exercise.
const upstream=async request=>{
 assert.equal(request.model,'gpt-5.3-codex');forwarded++;
 const text=phase==='review'?'CHANGES_REQUESTED: synthetic defect':phase==='final-review'?'PASS: synthetic repair verified':'DONE';
 const item={id:'msg_'+forwarded,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
 const response={id:'synthetic-response-'+forwarded,object:'response',created_at:1,model:request.model,status:'completed',output:[item],usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
 const events=[['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],['response.output_item.added',{type:'response.output_item.added',output_index:0,item}],['response.output_item.done',{type:'response.output_item.done',output_index:0,item}],['response.completed',{type:'response.completed',response}]];
 return {providerRequestId:response.id,actualTokens:5,usage:response.usage,contentType:'text/event-stream',body:events.map(([event,data])=>'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n').join('')+'data: [DONE]\n\n'};
};
const server=createNativeHttpBridge({db,grantToken:'synthetic-'+('z'.repeat(60)),trialId:'synthetic-trial',executionEpoch:1,providerNamespace:'openai',upperTokens:20000,upstream,recordReceipt:async r=>receipts.push(r),clientToken:token,fullMission:true});
// Observe structural metadata only. Never log prompts, auth headers or secrets.
server.on('request',req=>{let raw='';req.on('data',chunk=>{if(raw.length<2000000)raw+=chunk;});req.on('end',()=>{
 try{const b=JSON.parse(raw);const summary={phase,model:b.model,keys:Object.keys(b).sort(),inputBytes:Buffer.byteLength(JSON.stringify({...b,max_output_tokens:b.max_output_tokens??4096})),outputCap:b.max_output_tokens??4096,
 inputTypes:Array.isArray(b.input)?b.input.map(x=>({type:x.type,role:x.role,keys:Object.keys(x).sort(),contentTypes:Array.isArray(x.content)?x.content.map(c=>c.type):typeof x.content})):typeof b.input,
 toolTypes:b.tools?.map(t=>t.type),include:b.include,store:b.store,truncation:b.truncation};summaries.push(summary);console.log('ACTUAL_NATIVE_REQUEST_SHAPE='+JSON.stringify(summary));}catch{console.log('ACTUAL_NATIVE_REQUEST_SHAPE_INVALID');}
 });});
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
 for(const next of phases){
  phase=next;const reviewing=phase==='review'||phase==='final-review';
  const command='socat TCP-LISTEN:43181,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/gateway/gateway.sock & p=$!; trap "kill $p 2>/dev/null || :" EXIT; node /trusted/native-development-child.mjs';
  const args=sharedNativeContainerArgs({workspace:work,socketDir,arm:'full',phase,command,readOnly:reviewing,
   extraMounts:[...protectedNativeMounts(assertTrustedBoundary(work)),
    '--ro-bind',realpathSync(resolve('node_modules')),'/work/node_modules','--dir','/trusted',
    ...['native-development-child.mjs','shared-native-phase.mjs','shared-native-policy.mjs'].flatMap(f=>['--ro-bind',resolve('scripts/benchmark',f),'/trusted/'+f]),
    '--ro-bind',join(root,'AGENT_REQUEST.md'),'/trusted/AGENT_REQUEST.md','--ro-bind',join(root,'review-findings.txt'),'/trusted/review-findings.txt'],
   extraEnv:['--setenv','KATIE_NATIVE_MODEL','gpt-5.3-codex','--setenv','KATIE_NATIVE_BRIDGE_TOKEN',token,'--setenv','KATIE_NATIVE_BASELINE_SHA',baseline]});
  const child=spawn('bwrap',args,{env:{PATH:process.env.PATH||''},stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);
  const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
  let code;try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}finally{clearTimeout(timer);}
  assert.equal(code,0,phase+': '+errors+'\n'+output);
  if(reviewing){const marker=output.split('\n').find(x=>x.startsWith('NATIVE_REVIEW_RESULT='));assert.ok(marker);assert.equal(JSON.parse(marker.slice('NATIVE_REVIEW_RESULT='.length)).verdict,phase==='review'?'changes_requested':'pass');}
  else assert.match(output,/NATIVE_DEVELOPMENT_RETURNED_FOR_INDEPENDENT_VERIFICATION/);
  console.log('ACTUAL_NATIVE_CHILD_PHASE_PASS='+phase);
 }
 assert.equal(forwarded,4);assert.equal(receipts.length,4);assert.equal(summaries.length,4);
 assert.equal(calls.filter(x=>x.name==='benchmark_full_native_reserve').length,4);
 assert.equal(receipts.reduce((n,x)=>n+x.actualTokens,0),20);
 console.log('ACTUAL_NATIVE_CHILD_FULL_PAID_ADMISSION_NONBILLABLE_PASS');
}finally{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});}
