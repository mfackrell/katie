// Run the actual production child and model configuration through the real paid
// admission path. The isolated gateway has ONLY in-memory DB/synthetic responses.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createNativeHttpBridge} from './native-http-bridge.mjs';
import {assertProjectScope} from '../project-scope.mjs';
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
writeFileSync(join(root,'AGENT_REQUEST.md'),process.env.KATIE_NATIVE_PROBE_COMPLETION_BUDGET==='1'?readFileSync('tests/fixtures/take-eleven-frozen-development-request.md','utf8'):'Synthetic nonbillable qualification. Reply DONE. No repository changes.');
writeFileSync(join(root,'review-findings.txt'),'Synthetic defect: require final independent review.');
const expectedLogprobsDenial=process.env.KATIE_NATIVE_PROBE_EXPECT_LOGPROBS_DENIAL==='1';
const phases=expectedLogprobsDenial?['implementation']:['implementation','review','repair','final-review'];
const sourceWrite=process.env.KATIE_NATIVE_PROBE_SOURCE_WRITE==='1';
const probePath='app/project-pilots/take-eleven/qualification-probe.mjs';
if(sourceWrite){assert.equal(baseline,'0015bcdb8ac9ad94b7c74d1a4cd76737903b1319');writeFileSync(join(root,'AGENT_REQUEST.md'),readFileSync('tests/fixtures/take-eleven-frozen-development-request.md','utf8'));}
const realistic=process.env.KATIE_NATIVE_PROBE_COMPLETION_BUDGET==='1';
const phaseLimits={implementation:3,review:2,repair:3,'final-review':2};
const firstCounts={implementation:7139,review:7221,repair:7150,'final-review':7208};
let currentInput=0,used=0,held=0,nativeCalls=0,dollars=5486348;
const token='synthetic-bridge-token-not-a-provider-credential';
const completionCountRequests=[];
const calls=[],receipts=[],summaries=[],phaseRequests=new Map(),firstRequests=new Map();let phase='',forwarded=0,countedRequests=0;
const db={rpc:async(name,args)=>{
 calls.push({name,args});
 if(name==='benchmark_gateway_execution_live')return {data:true,error:null};
 if(name==='benchmark_full_native_reserve'){
  if(!expectedLogprobsDenial)assert.ok(args.p_tokens<=40780,'Authoritative fixture count must fit the remaining production capacity');
  if(realistic){assert.ok(nativeCalls<11);assert.ok(used+held+args.p_tokens<=234059);assert.ok(dollars+args.p_tokens*14<=10000000);held=args.p_tokens;nativeCalls++;}
  return {data:'synthetic-operation-'+calls.length,error:null};
 }
 throw Error('UNEXPECTED_PROBE_RPC:'+name);
}};
// Deliberately DO NOT set upstream.nonbillableFixture: it bypasses the actual
// request-shape and byte-bound admission checks that this probe must exercise.
const upstream=async request=>{
 assert.equal(request.model,'gpt-5.3-codex');forwarded++;
 const count=(phaseRequests.get(phase)??0)+1;phaseRequests.set(phase,count);
 assert.ok(count<=(realistic?phaseLimits[phase]:2),'Unexpected SDK continuation or retry');
 const callId='actual_native_tool_'+phase+'_'+count;
 const reviewing=phase==='review'||phase==='final-review';
 const encrypted=Buffer.from('synthetic-reasoning-'+phase).toString('base64');
 const tools=request.tools?.flatMap(t=>t.type==='namespace'?t.tools:[t])??[];
 assert.ok(tools.some(t=>t.type==='function'&&t.name==='exec_command'),'Actual SDK must declare the tested local exec_command tool');
 if(count>1){
  const output=request.input?.find(x=>x.type==='function_call_output'&&x.call_id==='actual_native_tool_'+phase+'_'+(count-1));
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
  assert.deepEqual(commentary.content,[{type:'output_text',text:'I will inspect the approved request and repository.',annotations:[],logprobs:[]}]);
 }

 const text=phase==='review'?'CHANGES_REQUESTED: synthetic defect':phase==='final-review'?'PASS synthetic repair verified':'DONE';
 const item=count<(realistic?phaseLimits[phase]:2)?{id:'fc_'+forwarded,type:'function_call',name:'exec_command',...(expectedLogprobsDenial?{}:{namespace:'functions'}),call_id:callId,
  arguments:JSON.stringify({cmd:(reviewing?reviewCommand:sourceWrite?"mkdir -p app/project-pilots/take-eleven && printf 'export const qualification = 1;\\n' > "+probePath+" && printf ACTUAL_NATIVE_TOOL_OK":'printf ACTUAL_NATIVE_TOOL_OK')+(realistic&&count===1?' ; cat /trusted/AGENT_REQUEST.md':''),workdir:'/work',...(realistic?{max_output_tokens:20000}:{})}),status:'completed'}:
  {id:'msg_'+forwarded,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[],logprobs:[]}]};
 const reasoning={id:'rs_'+phase,type:'reasoning',summary:[],encrypted_content:encrypted};
 const commentary={id:'msg_commentary_'+forwarded,type:'message',role:'assistant',phase:'commentary',status:'completed',content:[{type:'output_text',text:'I will inspect the approved request and repository.',annotations:[],logprobs:[]}]};
 const output=count===1?[reasoning,commentary,item]:[item];
 const response={id:'synthetic-response-'+forwarded,object:'response',created_at:1,model:request.model,status:'completed',output,usage:realistic?{input_tokens:currentInput,output_tokens:4096,total_tokens:currentInput+4096}:{input_tokens:3,output_tokens:2,total_tokens:5}};
 const events=[['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],...output.flatMap((item,output_index)=>[['response.output_item.added',{type:'response.output_item.added',output_index,item}],['response.output_item.done',{type:'response.output_item.done',output_index,item}]]),['response.completed',{type:'response.completed',response}]];
 return {providerRequestId:response.id,actualTokens:response.usage.total_tokens,usage:response.usage,contentType:'text/event-stream',body:events.map(([event,data])=>'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n').join('')+'data: [DONE]\n\n'};
};
// Synthetic count result exercises the actual SDK count-before-reserve path;
// the separate fixed-provider count job qualifies real model counting support.
upstream.countInputTokens=async body=>{countedRequests++;if(realistic)completionCountRequests.push({phase,body});assert.ok(Object.isFrozen(body));if(!firstRequests.has(phase))firstRequests.set(phase,body);currentInput=realistic?Math.ceil(((phaseRequests.get(phase)??0)===0?firstCounts[phase]:12795)*1.25):7000;return {inputTokens:currentInput,requestHash:createHash('sha256').update(JSON.stringify(body)).digest('hex')};};
const server=createNativeHttpBridge({db,grantToken:'synthetic-'+('z'.repeat(60)),trialId:'synthetic-trial',executionEpoch:1,providerNamespace:'openai',upperTokens:120000,upstream,recordReceipt:async r=>{receipts.push(r);if(realistic){used+=r.actualTokens;held=0;dollars+=r.actualTokens*14;}},clientToken:token,fullMission:true,requireInputCount:true});
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
  if(expectedLogprobsDenial){
   assert.notEqual(code,0,'Pre-fix gateway must reject the replay');
   assert.match(errors,/GATEWAY_REQUEST_DENIED/);
   assert.equal(forwarded,1);assert.equal(receipts.length,1);
   assert.equal(calls.filter(x=>x.name==='benchmark_full_native_reserve').length,1);
   assert.ok(summaries.some(s=>s.inputTypes?.some?.(i=>i.contentTypes?.some?.(c=>c.type==='output_text'&&c.keys.includes('logprobs')))),'Actual SDK must serialize replayed logprobs');
   console.log('ACTUAL_NATIVE_LOGPROBS_PRE_FIX_DENIAL_REPRODUCED');
   continue;
  }
  assert.equal(code,0,phase+': '+errors+'\n'+output);
  for(const path of [work,join(work,'.git'),sdkRoot])assert.equal(existsSync(join(path,reviewMarker)),false,'Reviewer cannot mutate protected mount '+path);
  if(reviewing){const marker=output.split('\n').find(x=>x.startsWith('NATIVE_REVIEW_RESULT='));assert.ok(marker);assert.equal(JSON.parse(marker.slice('NATIVE_REVIEW_RESULT='.length)).verdict,phase==='review'?'changes_requested':'pass');}
  else assert.match(output,/NATIVE_DEVELOPMENT_RETURNED_FOR_INDEPENDENT_VERIFICATION/);
  if(sourceWrite&&!reviewing){
   assert.equal(readFileSync(join(work,probePath),'utf8'),'export const qualification = 1;\n');
   execFileSync('git',['-C',work,'add','-A']);
   assert.deepEqual(assertProjectScope(join(root,'AGENT_REQUEST.md'),work),[probePath]);
   console.log('ACTUAL_NATIVE_SOURCE_WRITE_SCOPE_PASS='+phase);
  }
  console.log('ACTUAL_NATIVE_CHILD_PHASE_PASS='+phase);
 }
 if(!expectedLogprobsDenial){
 assert.equal(forwarded,realistic?10:8);assert.equal(receipts.length,realistic?10:8);assert.equal(summaries.length,realistic?10:8);
 assert.equal(countedRequests,realistic?10:8);
 assert.deepEqual([...phaseRequests.values()],realistic?[3,2,3,2]:[2,2,2,2]);
 assert.equal(calls.filter(x=>x.name==='benchmark_full_native_reserve').length,realistic?10:8);
 assert.equal(receipts.reduce((n,x)=>n+x.actualTokens,0),realistic?172823:40);
 if(realistic){assert.ok(process.env.RUNNER_TEMP);writeFileSync(join(process.env.RUNNER_TEMP,'native-sdk-completion-count-requests.json'),JSON.stringify(completionCountRequests),{mode:0o600});assert.equal(used,172823);assert.ok(used+60000<=294059);assert.ok(195941+used+60000+60000<=550000);assert.ok(dollars+(60000+60000)*14<=10000000);console.log('COMPLETION_SDK_ENVELOPE_PASS='+JSON.stringify({nativeCalls,developmentClosureCalls:4,developmentClosureTokens:60000,assessmentTokens:60000,used,dollars}));}
 console.log('ACTUAL_NATIVE_CHILD_FULL_PAID_ADMISSION_NONBILLABLE_PASS');
 if(process.env.KATIE_NATIVE_PROBE_CAPTURE_FIRST_REQUESTS==='1'){
  assert.ok(process.env.RUNNER_TEMP);assert.equal(firstRequests.size,4);
  const requests=phases.map(phase=>({phase,body:firstRequests.get(phase)}));
  assert.ok(requests.every(({body})=>!body.input?.some?.(item=>item.type==='reasoning')),'Capture only initial requests, never synthetic reasoning replay');
  const raw=JSON.stringify(requests);assert.ok(Buffer.byteLength(raw)<=2_000_000);
  writeFileSync(join(process.env.RUNNER_TEMP,'native-sdk-first-count-requests.json'),raw,{mode:0o600,flag:'wx'});
  console.log('ACTUAL_NATIVE_FIRST_REQUESTS_CAPTURED=4');
 }
 }
}finally{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});rmSync(join(sdkRoot,reviewMarker),{force:true});}




