// Run the actual production child and model configuration through the real paid
// admission path. The isolated gateway has ONLY in-memory DB/synthetic responses.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createNativeHttpBridge} from './native-http-bridge.mjs';
import {sharedNativeContainerArgs} from './shared-native-container.mjs';
import {assertTrustedBoundary,protectedNativeMounts} from './native-trust-boundary.mjs';
const reviewMarker='KATIE_REVIEW_PROBE_'+randomUUID().replaceAll('-','');
const sdkRoot=realpathSync(resolve('node_modules'));
const reviewCommand='printf ACTUAL_NATIVE_TOOL_OK; '+[['/work','WORK'],['/work/.git','GIT'],['/work/node_modules','DEPS']].map(([path,label])=>'if (printf forbidden > '+path+'/'+reviewMarker+') 2>/dev/null; then printf '+label+'_WRITE_UNEXPECTEDLY_SUCCEEDED; else printf READ_ONLY_ENFORCED_'+label+'; fi').join('; ')+'; printf permitted > /tmp/'+reviewMarker+' && test "$(cat /tmp/'+reviewMarker+')" = permitted && printf TMP_WRITE_ALLOWED';
const root=mkdtempSync(join(tmpdir(),'actual-native-child-'));
const work=join(root,'work'),socketDir=join(root,'socket'),socket=join(socketDir,'gateway.sock');
mkdirSync(socketDir);
if(process.env.KATIE_NATIVE_PROBE_BASELINE){
 const ref=process.env.KATIE_NATIVE_PROBE_BASELINE;
 assert.match(ref,/^[a-f0-9]{40}$/);
 execFileSync('git',['clone','--no-hardlinks','--no-checkout',resolve('.'),work],{stdio:'pipe'});
 execFileSync('git',['-C',work,'fetch',resolve('.'),ref],{stdio:'pipe'});
 execFileSync('git',['-C',work,'checkout','--detach',ref],{stdio:'pipe'});
 mkdirSync(join(work,'node_modules'),{recursive:true});
}else{
 mkdirSync(work);mkdirSync(join(work,'node_modules'));
 execFileSync('git',['init','-q',work]);
 execFileSync('git',['-C',work,'-c','user.name=Synthetic probe','-c','user.email=probe@example.invalid','commit','--allow-empty','-qm','Synthetic baseline']);
}
const baseline=execFileSync('git',['-C',work,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
writeFileSync(join(root,'AGENT_REQUEST.md'),'Synthetic nonbillable qualification. Reply DONE. No repository changes.');
writeFileSync(join(root,'review-findings.txt'),'Synthetic defect: require final independent review.');
const phases=['implementation','review','repair','final-review'];
const token='synthetic-bridge-token-not-a-provider-credential';
const calls=[],receipts=[],summaries=[],phaseRequests=new Map();let phase='',forwarded=0;
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
 const count=(phaseRequests.get(phase)??0)+1;phaseRequests.set(phase,count);
 assert.ok(count<=2,'Unexpected SDK continuation or retry');
 const callId='actual_native_tool_'+phase;
 const reviewing=phase==='review'||phase==='final-review';
 const encrypted=Buffer.from('synthetic-reasoning-'+phase).toString('base64');
 const tools=request.tools?.flatMap(t=>t.type==='namespace'?t.tools:[t])??[];
 assert.ok(tools.some(t=>t.type==='function'&&t.name==='exec_command'),'Actual SDK must declare the tested local exec_command tool');
 if(count===2){
  const output=request.input?.find(x=>x.type==='function_call_output'&&x.call_id===callId);
  assert.ok(output,'Actual SDK tool output must return through paid admission');
  const safeOutput=JSON.stringify(output.output).split(token).join('[REDACTED]').slice(0,2000);
  if(!safeOutput.includes('ACTUAL_NATIVE_TOOL_OK'))console.error('ACTUAL_NATIVE_TOOL_OUTPUT_FAILURE='+JSON.stringify({phase,output:safeOutput}));
  assert.match(safeOutput,/ACTUAL_NATIVE_TOOL_OK/,'Actual local exec must succeed');
  if(reviewing){for(const label of ['WORK','GIT','DEPS'])assert.ok(safeOutput.includes('READ_ONLY_ENFORCED_'+label),'Reviewer must reject writes to '+label);assert.match(safeOutput,/TMP_WRITE_ALLOWED/,'Reviewer retains isolated writable scratch');}
  const reasoning=request.input?.find(x=>x.type==='reasoning');
  assert.ok(reasoning,'Actual SDK must replay trusted opaque reasoning inline');
  assert.equal(reasoning.encrypted_content,encrypted);assert.deepEqual(reasoning.summary,[]);
  const commentary=request.input?.find(x=>x.type==='message'&&x.role==='assistant'&&x.phase==='commentary');
  assert.ok(commentary,'Real SDK must replay intermediate assistant text');
  assert.deepEqual(commentary.content,[{type:'output_text',text:'I will inspect the approved request and repository.',annotations:[]}]);
 }

 const text=phase==='review'?'CHANGES_REQUESTED: synthetic defect':phase==='final-review'?'PASS synthetic repair verified':'DONE';
 const item=count===1?{id:'call_'+forwarded,type:'function_call',name:'exec_command',call_id:callId,
  arguments:JSON.stringify({cmd:reviewing?reviewCommand:'printf ACTUAL_NATIVE_TOOL_OK',workdir:'/work'}),status:'completed'}:
  {id:'msg_'+forwarded,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
 const reasoning={id:'rs_'+phase,type:'reasoning',summary:[],encrypted_content:encrypted};
 const commentary={id:'msg_commentary_'+forwarded,type:'message',role:'assistant',phase:'commentary',status:'completed',content:[{type:'output_text',text:'I will inspect the approved request and repository.',annotations:[]}]};
 const output=count===1?[reasoning,commentary,item]:[item];
 const response={id:'synthetic-response-'+forwarded,object:'response',created_at:1,model:request.model,status:'completed',output,usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
 const events=[['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],...output.flatMap((item,output_index)=>[['response.output_item.added',{type:'response.output_item.added',output_index,item}],['response.output_item.done',{type:'response.output_item.done',output_index,item}]]),['response.completed',{type:'response.completed',response}]];
 return {providerRequestId:response.id,actualTokens:5,usage:response.usage,contentType:'text/event-stream',body:events.map(([event,data])=>'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n').join('')+'data: [DONE]\n\n'};
};
const server=createNativeHttpBridge({db,grantToken:'synthetic-'+('z'.repeat(60)),trialId:'synthetic-trial',executionEpoch:1,providerNamespace:'openai',upperTokens:120000,upstream,recordReceipt:async r=>receipts.push(r),clientToken:token,fullMission:true});
// Observe structural metadata only. Never log prompts, auth headers or secrets.
server.on('request',req=>{let raw='';req.on('data',chunk=>{if(raw.length<2000000)raw+=chunk;});req.on('end',()=>{
 try{const b=JSON.parse(raw);const nontextPaths=[];
 const inspectNontext=(v,path='$')=>{
  if(!v||typeof v!=='object')return;
  if(['input_image','input_audio','input_video','image_url','file_id'].includes(v.type))nontextPaths.push(path+'.type='+v.type);
  for(const [k,x]of Object.entries(v)){
   if(['image_url','input_audio','input_image','audio','file_id'].includes(k))nontextPaths.push(path+'.'+k);
   inspectNontext(x,path+'.'+k);
  }
 };inspectNontext(b);
 const summary={phase,model:b.model,keys:Object.keys(b).sort(),inputBytes:Buffer.byteLength(JSON.stringify({...b,max_output_tokens:b.max_output_tokens??4096})),outputCap:b.max_output_tokens??4096,nontextPaths:nontextPaths.slice(0,50),
 inputTypes:Array.isArray(b.input)?b.input.map(x=>({type:x.type,role:x.role,keys:Object.keys(x).sort(),idType:x.id===null?'null':typeof x.id,outputType:Array.isArray(x.output)?'array':typeof x.output,contentTypes:Array.isArray(x.content)?x.content.map(c=>({type:c.type,keys:Object.keys(c).sort()})):typeof x.content})):typeof b.input,
 toolTypes:b.tools?.map(t=>({type:t.type,name:t.name,nested:t.tools?.map(n=>({type:n.type,name:n.name}))})),clientMetadata:b.client_metadata&&Object.fromEntries(Object.entries(b.client_metadata).map(([k,v])=>[k,v===null?'null':typeof v])),promptCacheKeyType:b.prompt_cache_key===null?'null':typeof b.prompt_cache_key,reasoningKeys:b.reasoning&&Object.keys(b.reasoning).sort(),include:b.include,store:b.store,truncation:b.truncation};summaries.push(summary);console.log('ACTUAL_NATIVE_REQUEST_SHAPE='+JSON.stringify(summary));}catch{console.log('ACTUAL_NATIVE_REQUEST_SHAPE_INVALID');}
 });});
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
 for(const next of phases){
  phase=next;const reviewing=phase==='review'||phase==='final-review';
  const command='socat TCP-LISTEN:43181,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/gateway/gateway.sock & p=$!; trap "kill $p 2>/dev/null || :" EXIT; node /trusted/native-development-child.mjs';
  const args=sharedNativeContainerArgs({workspace:work,socketDir,arm:'full',phase,command,readOnly:reviewing,
   extraMounts:[...protectedNativeMounts(assertTrustedBoundary(work)),
    '--ro-bind',sdkRoot,'/work/node_modules','--dir','/trusted',
    ...['native-development-child.mjs','shared-native-phase.mjs','shared-native-policy.mjs'].flatMap(f=>['--ro-bind',resolve('scripts/benchmark',f),'/trusted/'+f]),
    '--ro-bind',join(root,'AGENT_REQUEST.md'),'/trusted/AGENT_REQUEST.md','--ro-bind',join(root,'review-findings.txt'),'/trusted/review-findings.txt'],
   extraEnv:['--setenv','KATIE_NATIVE_MODEL','gpt-5.3-codex','--setenv','KATIE_NATIVE_BRIDGE_TOKEN',token,'--setenv','KATIE_NATIVE_BASELINE_SHA',baseline]});
  const child=spawn('bwrap',args,{env:{PATH:process.env.PATH||''},stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);
  const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
  let code;try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}finally{clearTimeout(timer);}
  assert.equal(code,0,phase+': '+errors+'\n'+output);
  for(const path of [work,join(work,'.git'),sdkRoot])assert.equal(existsSync(join(path,reviewMarker)),false,'Reviewer cannot mutate protected mount '+path);
  if(reviewing){const marker=output.split('\n').find(x=>x.startsWith('NATIVE_REVIEW_RESULT='));assert.ok(marker);assert.equal(JSON.parse(marker.slice('NATIVE_REVIEW_RESULT='.length)).verdict,phase==='review'?'changes_requested':'pass');}
  else assert.match(output,/NATIVE_DEVELOPMENT_RETURNED_FOR_INDEPENDENT_VERIFICATION/);
  console.log('ACTUAL_NATIVE_CHILD_PHASE_PASS='+phase);
 }
 assert.equal(forwarded,8);assert.equal(receipts.length,8);assert.equal(summaries.length,8);
 assert.deepEqual([...phaseRequests.values()],[2,2,2,2]);
 assert.equal(calls.filter(x=>x.name==='benchmark_full_native_reserve').length,8);
 assert.equal(receipts.reduce((n,x)=>n+x.actualTokens,0),40);
 console.log('ACTUAL_NATIVE_CHILD_FULL_PAID_ADMISSION_NONBILLABLE_PASS');
}finally{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});rmSync(join(sdkRoot,reviewMarker),{force:true});}
