import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID, webcrypto } from 'node:crypto';
const native=createRequire(import.meta.url);
function modules(overrides={}){
 const cache=new Map();
 const load=name=>{
  if(name in overrides)return overrides[name];
  if(!name.startsWith('@/')&&!name.startsWith('/')&&!name.startsWith('.'))return native(name);
  let path=name.startsWith('@/')?resolve(name.slice(2)):resolve(name);
  if(!path.endsWith('.ts'))path=existsSync(path+'.ts')?path+'.ts':resolve(path,'index.ts');
  if(cache.has(path))return cache.get(path);
  const exports={};cache.set(path,exports);
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  vm.runInNewContext(code,{exports,require:n=>n.startsWith('.')?load(resolve(dirname(path),n)):load(n),process,Buffer,Date,console,Set,Map,URL,URLSearchParams,TextEncoder,TextDecoder,Request,Response,Headers,ReadableStream,AbortController,AbortSignal,File,Blob,fetch,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval},{filename:path});
  return exports;
 };
 return load;
}
function zipJSON(name,body) {
  const file=Buffer.from(name),content=Buffer.from(JSON.stringify(body));
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt32LE(content.length,18);local.writeUInt32LE(content.length,22);local.writeUInt16LE(file.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt32LE(content.length,20);central.writeUInt32LE(content.length,24);central.writeUInt16LE(file.length,28);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+file.length,12);end.writeUInt32LE(local.length+file.length+content.length,16);
  return Buffer.concat([local,file,content,central,file,end]);
}
const config={name:'Writer',instructions:'Original immutable purpose',research:false,attachments:false,development:true,reviewMode:'always',maxActiveTasks:1,maxInputChars:1000};
const baseTask=()=>({id:randomUUID(),agent_id:randomUUID(),actor_id:randomUUID(),chat_id:randomUUID(),snapshot:{...config},definition_version:1,kind:'general',initial_input:'Saved task',input:'Saved task',request_id:'agent:request',status:'running',details:null,repository_full_name:null,external:{}});
function fixture(task=baseTask()){
 let fail=false,recover=false,savedSources=[],claims=0;const rows=[];const requestRecords=new Map();
 const admin={rpc:async(name,args)=>{
  if(name==='check_agent_chat')return {data:!fail&&args.p_actor===task.actor_id&&args.p_chat===task.chat_id&&args.p_request===task.request_id?task:null,error:fail||args.p_actor!==task.actor_id||args.p_chat!==task.chat_id||args.p_request!==task.request_id?{message:'Denied'}:null};
  if(name==='recover_agent_execution'){if(recover){task.status='failed';task.details='Execution interrupted. Continue this saved conversation to retry.';}return {data:recover,error:null};}
  if(name==='claim_agent_execution')return {data:++claims===1,error:null};
  return {data:null,error:null};
 },from(table){let filters=[];const q={select:()=>q,eq:(k,v)=>{filters.push([k,v]);return q;},order:()=>q,limit:()=>q,update:async patch=>{if(table==='agent_tasks'&&filters.every(([k,v])=>task[k]===v))Object.assign(task,patch);return{error:null};},maybeSingle:async()=>({data:table==='managed_agents'?{id:task.agent_id,actor_id:task.actor_id,config:task.snapshot}:table==='agent_tasks'?task:table==='chat_requests'?{review_audit:{status:'needs_user_input'}}:{state:{pending:[]}},error:null})};return q;}};
 const load=modules({
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>admin},
  '@/lib/data/persistence-store':{listChatsByActorId:async()=>[{id:task.chat_id,actorId:task.actor_id}],getMessages:async()=>[],getRecentMessages:async()=>[],getChatById:async id=>id===task.chat_id?{id,actorId:task.actor_id}:null,saveMessage:async(_,m)=>rows.push(m)},
  '@/lib/uploads/stored-uploads':{loadConversationAttachmentCatalog:async()=>savedSources,loadActorAttachmentCatalog:async()=>[],hydrateStoredAttachments:async()=>[],retrySavedEvidence:async()=>{}},
  '@/lib/chat/request-idempotency':{fingerprintChatRequest:async()=> 'fingerprint',claimChatRequest:async input=>{requestRecords.set(input.requestId,{...input,status:'processing'});return{mode:'claimed',tracked:true};},completeChatRequest:async(id,output)=>requestRecords.set(id,{...requestRecords.get(id),...output,status:'completed'}),getChatRequest:async id=>requestRecords.get(id)??null},
  '@/lib/chat/local-katie':{resolveLocalKatieResponse:async()=>({reason:'system-prompt',text:'Actual deterministic engine output'})},
  '@/lib/memory/short-term':{refreshShortTermMemory:async()=>{}},
 });
 return {load,task,rows,requestRecords,setFail:v=>fail=v,setRecover:v=>recover=v,setSources:v=>savedSources=v};
}
test('actual managed runtime guard rejects forged actor/chat/config/model/repo/new and saved source payloads',async()=>{
 const f=fixture(),runtime=f.load('@/lib/agents/runtime');
 const invoke=extra=>{const payload={actorId:f.task.actor_id,chatId:f.task.chat_id,message:f.task.input,...extra};return runtime.authorizeManagedChat(new Request('http://local/api/chat',{method:'POST',headers:{'content-type':'application/json','x-request-id':f.task.request_id},body:JSON.stringify(payload)}),payload);};
 assert.equal((await invoke({})).snapshot.instructions,config.instructions);
 for(const forged of [{actorId:randomUUID()},{chatId:randomUUID()},{message:'Changed'},{snapshot:{research:true}},{overrideProvider:'grok'},{activeRepoId:'repo',repoInjectionEnabled:true},{images:['data:image/png;base64,YQ==']},{fileReferences:[{fileId:'other-actor'}]}])await assert.rejects(invoke(forged));
 f.setSources([{id:'saved'}]);await assert.rejects(invoke({}),/Saved attachment/);
 f.setSources([]);f.setFail(true);await assert.rejects(invoke({}),/authorization/);
});
test('actual POST reuses the chat engine, persists output, and repeated starts do not rerun work',async()=>{
 const f=fixture(),route=f.load('@/app/api/chat/route');
 const request=(extra={})=>new (native('next/server').NextRequest)('http://local/api/chat',{method:'POST',headers:{'content-type':'application/json','x-request-id':f.task.request_id},body:JSON.stringify({actorId:f.task.actor_id,chatId:f.task.chat_id,message:f.task.input,repoInjectionEnabled:false,...extra})});
 for(const forged of [{actorId:randomUUID()},{chatId:randomUUID()},{overrideModel:"gpt"},{snapshot:{research:true}},{activeRepoId:"repo",repoInjectionEnabled:true},{message:"Changed input"}]){assert.equal((await route.POST(request(forged))).status,403);assert.equal(f.rows.length,0);}
 const first=await route.POST(request());
 assert.equal(first.status,200,await first.clone().text());
 assert.match(await first.text(),/Actual deterministic engine output/);
 assert.equal(f.rows.length,2);
 assert.equal(f.requestRecords.get(f.task.request_id).status,'completed');
 const replay=await route.POST(request());assert.equal(replay.status,202);assert.equal(f.rows.length,2);
 assert.equal((await replay.json()).task.status,'pending','HTTP 200 completed text cannot hide pending independent review');
});
test('actual task refresh exposes durable interrupted failure without launching another execution',async()=>{
 const f=fixture();f.setRecover(true);
 const route=f.load('@/app/api/agent-tasks/route');
 const request=new (native('next/server').NextRequest)('http://local/api/agent-tasks?id='+f.task.id);
 const result=await route.GET(request);
 assert.equal(result.status,200);
 const saved=(await result.json()).task;
 assert.equal(saved.status,'failed');assert.match(saved.details,/interrupted/);
 assert.equal(saved.chat_id,f.task.chat_id);assert.equal(saved.request_id,f.task.request_id);
 assert.equal(f.rows.length,0);assert.equal(f.requestRecords.size,0);
});
test('async policy isolation blocks the real web adapter and browser collector before external work',async()=>{
 const load=modules(),{runAgentTask,requireAgentResearch,currentAgentTask}=load('@/lib/agents/policy');
 const denied=baseTask(),allowed={...baseTask(),snapshot:{...config,research:true}};
 await Promise.all([runAgentTask(denied,async()=>{await Promise.resolve();assert.equal(currentAgentTask().id,denied.id);assert.throws(requireAgentResearch,/disabled/);
  const {collectWebsiteEvidence}=load('@/lib/research/website-evidence');let launches=0;
  await assert.rejects(collectWebsiteEvidence({user:'Review https://example.com',history:[],persona:'',summary:'',name:'Katie',requestIntent:'web-search'},{launch:async()=>{launches++;throw Error('must not launch');}}),/disabled/);assert.equal(launches,0);
  const {GrokProvider}=load('@/lib/providers/grok-provider');await assert.rejects(new GrokProvider('fake').createWebSearchResponse('grok',[]),/disabled/);
 }),runAgentTask(allowed,async()=>{await Promise.resolve();assert.equal(currentAgentTask().id,allowed.id);requireAgentResearch();})]);
 assert.equal(currentAgentTask(),undefined);requireAgentResearch();
});
test('trusted workflow receipt parsing requires exact associations, real successful tests/review and a PR',()=>{
 const {parseCompletionReceipt}=modules()('@/lib/agents/development');
 const receipt={version:1,repository:'owner/repo',run_id:1,issue_number:2,pr_url:'https://github.com/owner/repo/pull/3',outcome:'READY',checks:{build:'success',test:'true',review:'pass',repair:'skipped',retest:'',final_review:''}};
 assert.equal(parseCompletionReceipt(receipt,'owner/repo',2,1,'success').outcome,'READY');
 for(const changed of [{outcome:'BLOCKED'},{pr_url:null},{checks:{...receipt.checks,test:'false'}},{checks:{...receipt.checks,review:'fail'}},{checks:{...receipt.checks,repair:'failure'}},{checks:{...receipt.checks,final_review:'fail'}}])assert.equal(parseCompletionReceipt({...receipt,...changed},'owner/repo',2,1,'success').outcome,'BLOCKED');
 assert.equal(parseCompletionReceipt(receipt,'owner/repo',2,1,'failure').outcome,'BLOCKED');
 assert.throws(()=>parseCompletionReceipt(receipt,'other/repo',2,1,'success'),/association/);
 assert.throws(()=>parseCompletionReceipt({...receipt,pr_url:'https://evil.example/pull/3'},'owner/repo',2,1,'success'),/Invalid receipt PR/);
 const sha='a'.repeat(40);assert.equal(parseCompletionReceipt({...receipt,tested_head_sha:sha,reviewed_head_sha:sha},'owner/repo',2,1,'success').outcome,'READY');
 for(const heads of [{tested_head_sha:sha,reviewed_head_sha:'b'.repeat(40)},{tested_head_sha:sha,reviewed_head_sha:null},{tested_head_sha:null,reviewed_head_sha:null}])assert.equal(parseCompletionReceipt({...receipt,...heads},'owner/repo',2,1,'success').outcome,'BLOCKED');
});

test('actual development dispatch rejects non-owner/app credentials and reconciles ambiguous acceptance without another write',async()=>{
 for(const identity of [{login:'bot',type:'Bot'},{login:'collaborator',type:'User'},{login:'owner',type:'User'},{login:'owner',type:'User',workflowMissing:true}]){
  const task={...baseTask(),kind:'development',status:'dispatching',repository_id:randomUUID(),repository_full_name:'owner/repo'};
  let claimed=false,writes=0,issue=null;
  const db={rpc:async()=>({data:!claimed&&(claimed=true),error:null}),from(table){let q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:table==='repo_sync_runs'?{repository_full_name:'owner/repo'}:table==='managed_agents'?{id:task.agent_id,actor_id:task.actor_id,config:task.snapshot}:task,error:null}),update:async patch=>{Object.assign(task,patch);return{error:null};}};return q;}};
  class GitHub {
   users={getAuthenticated:async()=>({data:identity})};
   repos={get:async()=>({data:{owner:{login:'owner',type:'User'}}})};
   issues={create:async payload=>{writes++;assert.match(payload.body,/Original immutable purpose/);assert.match(payload.body,new RegExp(task.id));issue={number:7,html_url:'https://github.com/owner/repo/issues/7',title:payload.title,body:payload.body,user:{login:'owner'}};throw Error('lost acknowledgement after acceptance');},listForRepo:async()=>({data:issue?[issue]:[]})};
   actions={getWorkflow:async()=>{if(identity.workflowMissing)throw Error('missing workflow');return{data:{path:'.github/workflows/autonomous-development.yml',state:'active'}};},listWorkflowRuns:async()=>({data:{workflow_runs:[]}})};
  }
  const old=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='fixture-only';
  try {
   const development=modules({'@octokit/rest':{Octokit:GitHub},'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/data/persistence-store':{getChatById:async()=>({actorId:task.actor_id})}})('@/lib/agents/development');
   const started=await development.dispatchDevelopment({...task});
   if(identity.login!=='owner'||identity.workflowMissing) {assert.equal(started.status,'blocked');assert.match(started.details,identity.workflowMissing?/workflow is unavailable/:/human owner/);assert.equal(writes,0);}
   else {
    assert.equal(started.status,'dispatching');assert.equal(writes,1);
    await development.dispatchDevelopment(started);assert.equal(writes,1);
    const reconciled=await development.reconcileDevelopment(started);assert.equal(reconciled.status,'submitted');assert.equal(reconciled.external.issueNumber,7);assert.equal(writes,1);
   }
  }finally{if(old===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=old;}
 }
});
test('actual context assembly uses the admitted instructions/review preference after actor edits',async()=>{
 const load=modules({'@/lib/data/persistence-store':{
  getChatContextState:async()=>({actor:{purpose:'Edited after admission',reviewMode:'off'},recentMessages:[],shortTermMemory:{},intermediateMemory:{},longTermMemory:{}}),
  listActorMemoryDocuments:async()=>[],
 }});
 const {runAgentTask}=load('@/lib/agents/policy'),{assembleContext}=load('@/lib/memory/assemble-context');
 const task=baseTask();
 const context=await runAgentTask(task,()=>assembleContext(task.actor_id,task.chat_id));
 assert.match(context.persona,/Original immutable purpose/);assert.doesNotMatch(context.persona,/Edited after admission/);assert.equal(context.reviewMode,'always');
 const ordinary=await assembleContext(task.actor_id,task.chat_id);assert.match(ordinary.persona,/Edited after admission/);assert.equal(ordinary.reviewMode,'off');
});
test('denied managed tasks cannot inspect saved video or evidence bodies through the production media entry points',async()=>{
 let reads=0;
 const load=modules({'@/lib/media-memory/evidence':{retrieveSavedEvidence:async()=>{reads++;return{};}},'@/lib/chat/saved-video-observations':{loadSavedVideoFollowUp:async()=>{reads++;return{};}}});
 const {runAgentTask}=load('@/lib/agents/policy'),media=load('@/lib/agents/media');
 await runAgentTask(baseTask(),async()=>{assert.equal(await media.retrieveSavedEvidence({}),null);assert.equal(await media.loadSavedVideoFollowUp({}),null);});assert.equal(reads,0);
 await media.retrieveSavedEvidence({});await media.loadSavedVideoFollowUp({});assert.equal(reads,2);
});
test('actual definition/task APIs create, reload, edit, archive and reject client snapshot/hidden execution options',async()=>{
 const tables={managed_agents:[],agent_tasks:[]},chats=new Map();
 const db={from(table){let filters=[];const found=()=>tables[table].filter(row=>filters.every(([k,v])=>row[k]===v));const q={select:()=>q,order:()=>q,limit:()=>q,eq:(k,v)=>{filters.push([k,v]);return q;},then:(resolve,reject)=>Promise.resolve({data:structuredClone(found()),error:null}).then(resolve,reject),maybeSingle:async()=>({data:structuredClone(found()[0]??null),error:null})};return q;},rpc:async(name,args)=>{
  if(name==='save_managed_agent'){
   let a=tables.managed_agents.find(a=>a.id===args.p_id);
   if(a)Object.assign(a,{config:structuredClone(args.p_config),archived:args.p_archive,version:a.version+1});
   else {a={id:randomUUID(),actor_id:randomUUID(),config:structuredClone(args.p_config),archived:false,version:1};tables.managed_agents.push(a);}
   return{data:structuredClone(a),error:null};
  }
  if(name==='create_agent_task'){
   const a=tables.managed_agents.find(a=>a.id===args.p_agent);
   const task={...baseTask(),id:args.p_id,agent_id:a.id,actor_id:a.actor_id,snapshot:structuredClone(a.config),initial_input:args.p_input,input:args.p_input,status:'draft'};
   tables.agent_tasks.push(task);chats.set(task.chat_id,{actorId:task.actor_id});return{data:structuredClone(task),error:null};
  }
  throw Error('Unexpected RPC '+name);
 }};
 const load=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/data/persistence-store':{getChatById:async id=>chats.get(id)??null},'@/lib/chat/request-idempotency':{getChatRequest:async()=>null}});
 const {NextRequest}=native('next/server'),agents=load('@/app/api/agents/route'),tasks=load('@/app/api/agent-tasks/route');
 const req=(path,body)=>new NextRequest('http://local'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const saved=await agents.POST(req('/api/agents',{config}));assert.equal(saved.status,200);const agent=(await saved.json()).agent;
 assert.equal((await (await agents.GET()).json()).agents[0].config.instructions,config.instructions);
 const id=randomUUID();const created=await tasks.POST(req('/api/agent-tasks',{action:'create',id,agentId:agent.id,input:'Write a brief',kind:'general'}));assert.equal(created.status,200);
 const edited=await agents.POST(req('/api/agents',{id:agent.id,config:{...config,instructions:'Edited later'}}));assert.equal(edited.status,200);
 const read=await tasks.GET(req('/api/agent-tasks?id='+id));assert.equal(read.status,200);assert.equal((await read.json()).task.snapshot.instructions,config.instructions);
 for(const forged of [{action:'create',id:randomUUID(),agentId:agent.id,input:'x',kind:'general',snapshot:{research:true}},{action:'start',id,overrideModel:'unbounded'},{action:'start',id,actorId:randomUUID()},{action:'start',id,message:'Replace approved input'}])assert.equal((await tasks.POST(req('/api/agent-tasks',forged))).status,409);
 assert.equal((await agents.POST(req('/api/agents',{id:agent.id,config,archive:true}))).status,200);
 assert.equal((await (await agents.GET()).json()).agents[0].archived,true);
 assert.equal((await agents.POST(req('/api/agents',{config:{...config,attachments:true}}))).status,400);
});
test('direct durable video registration cannot bypass unavailable managed attachment permissions',async()=>{
 const f=fixture(),route=f.load('@/app/api/video-handoffs/route');
 const {NextRequest}=native('next/server');
 const response=await route.POST(new NextRequest('http://local/api/video-handoffs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:randomUUID(),actorId:f.task.actor_id,chatId:f.task.chat_id,message:'Inspect this video',files:[{name:'private.mp4',type:'video/mp4',size:100}]})}));
 assert.equal(response.status,403);assert.match((await response.json()).error,/unavailable/);
});
test('actual artifact parser reads only the fixed bounded receipt and rejects oversized or unrelated files',()=>{
 const {completionJson}=modules()('@/lib/agents/development');
 const archive=zipJSON;
 assert.equal(completionJson(archive('agent-result.json',{version:1})).version,1);
 assert.throws(()=>completionJson(archive('../agent-result.json',{version:1})),/missing/);
 assert.throws(()=>completionJson(Buffer.alloc(1000001)),/too large/);
 assert.throws(()=>completionJson(archive('agent-result.json',{text:'x'.repeat(66000)})),/bounds/);
});
test('actual workflow reconciliation persists exact READY/BLOCKED receipts and links without dispatching new work',async()=>{
 const prior=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='fixture-only';
 try{
  for(const [outcome,conclusion,tests,expected] of [['READY','success','true','ready'],['READY','success','false','blocked'],['BLOCKED','success','true','blocked'],['READY','failure','true','blocked']]){
   const task={...baseTask(),kind:'development',status:'submitted',repository_id:randomUUID(),repository_full_name:'owner/repo',external:{attempted:true,issueNumber:7,issueUrl:'https://github.com/owner/repo/issues/7'}};
   const receipt={version:1,repository:'owner/repo',run_id:99,issue_number:7,pr_url:'https://github.com/owner/repo/pull/8',outcome,checks:{build:'success',test:tests,review:'pass',repair:'skipped',retest:'',final_review:''}};
   const db={from(){let q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{repository_full_name:'owner/repo'},error:null}),update:async patch=>{Object.assign(task,patch);return{error:null};}};return q;}};
   class GitHub {actions={listWorkflowRuns:async()=>({data:{workflow_runs:[{id:99,status:'completed',conclusion,event:'issues',repository:{full_name:'owner/repo'},head_repository:{full_name:'owner/repo'},head_branch:'main',path:'.github/workflows/autonomous-development.yml',html_url:'https://github.com/owner/repo/actions/runs/99'}]}}),listWorkflowRunArtifacts:async()=>({data:{artifacts:[{name:'agent-completion',id:10,expired:false,size_in_bytes:500}]}}),downloadArtifact:async()=>({data:zipJSON('agent-result.json',receipt)})};}
   const {reconcileDevelopment}=modules({'@octokit/rest':{Octokit:GitHub},'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db}})('@/lib/agents/development');
   const actual=await reconcileDevelopment(task);assert.equal(actual.status,expected);assert.equal(task.status,expected);assert.equal(actual.external.runUrl,'https://github.com/owner/repo/actions/runs/99');assert.equal(actual.external.prUrl,receipt.pr_url);assert.equal(actual.external.receipt.outcome,expected==='ready'?'READY':'BLOCKED');
  }
 }finally{if(prior===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=prior;}
});

test('continuation API requires client identity and returns the immutable accepted receipt separately from current task',async()=>{
 const task=baseTask(),turnId=randomUUID(),args=[],receipt={turn_id:turnId,request_id:'agent:old',input:'Continue',base_request_id:'agent:base'};
 const load=modules({'@/lib/agents/store':{readTask:async()=>task,agentRpc:async(name,input)=>{args.push({name,input});return{...task,continuation_receipt:receipt};}}});
 const {NextRequest}=native('next/server'),route=load('@/app/api/agent-tasks/route');
 const send=body=>route.POST(new NextRequest('http://local/api/agent-tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
 const body={action:'continue',id:task.id,message:'Continue',turnId,expectedRequestId:'agent:base'};
 for(const invalid of [{...body,turnId:undefined},{...body,expectedRequestId:undefined},{...body,turnId:'invalid'},{...body,snapshot:{research:true}}])assert.equal((await send(invalid)).status,409);
 assert.equal(args.length,0);
 const response=await send(body);assert.equal(response.status,200);const result=await response.json();
 assert.deepEqual(result.continuation,receipt);assert.equal(result.task.request_id,task.request_id);assert.equal(result.task.continuation_receipt,undefined);
 assert.deepEqual(JSON.parse(JSON.stringify(args[0])),{name:'transition_agent_task',input:{p_id:task.id,p_action:'continue',p_message:'Continue',p_turn:turnId,p_expected_request:'agent:base'}});
});

test('project receipts require every approved scenario and exact project, digest and tested/reviewed head',()=>{
 const {parseCompletionReceipt}=modules()('@/lib/agents/development');
 const sha='a'.repeat(40),projectId=randomUUID(),hash='b'.repeat(64);
 const binding={projectId,contractHash:hash,scenarioNames:['Human move','AI opponent']};
 const acceptance={version:1,projectId,contractHash:hash,headSha:sha,passed:true,checks:binding.scenarioNames.map(name=>({name,passed:true,detail:'Observed rendered gameplay assertion'}))};
 const receipt={version:1,repository:'owner/repo',run_id:1,issue_number:2,pr_url:'https://github.com/owner/repo/pull/3',outcome:'READY',checks:{build:'success',test:'true',review:'pass',repair:'skipped',retest:'',final_review:''},tested_head_sha:sha,reviewed_head_sha:sha,projectAcceptance:acceptance};
 const parse=value=>parseCompletionReceipt(value,'owner/repo',2,1,'success',binding);
 assert.equal(parse(receipt).outcome,'READY');
 assert.equal(parseCompletionReceipt(receipt,'owner/repo',2,1,'success').outcome,'BLOCKED','project evidence requires server-owned approval binding');
 const {projectAcceptance:omitted,...legacy}=receipt;
 assert.equal(parse(legacy).outcome,'BLOCKED','ordinary receipt cannot complete a project');
 assert.equal(parseCompletionReceipt(legacy,'owner/repo',2,1,'success').outcome,'READY','ordinary v1 remains supported');
 for(const changed of [{passed:false},{projectId:randomUUID()},{contractHash:'c'.repeat(64)},{headSha:'d'.repeat(40)},{checks:acceptance.checks.slice(0,1)},{checks:acceptance.checks.map((c,i)=>({...c,passed:i!==1}))},{checks:[acceptance.checks[0],acceptance.checks[0]]},{checks:[...acceptance.checks].reverse()}])assert.equal(parse({...receipt,projectAcceptance:{...acceptance,...changed}}).outcome,'BLOCKED');
 assert.throws(()=>parse({...receipt,projectAcceptance:{...acceptance,checks:[]}}));
 assert.throws(()=>parse({...receipt,projectAcceptance:{...acceptance,checks:[{name:'AI opponent',passed:true,detail:''}]}}));
 assert.equal(parse({...receipt,reviewed_head_sha:'e'.repeat(40)}).outcome,'BLOCKED');
 const repaired={...receipt,checks:{...receipt.checks,test:'false',review:'fail',repair:'success',retest:'true',final_review:'pass'}};
 assert.equal(parse(repaired).outcome,'READY');
 assert.equal(parse({...repaired,projectAcceptance:{...acceptance,passed:false}}).outcome,'BLOCKED','repair cannot waive browser retest');
});

test('preview URLs admit only HTTPS Vercel hosts or exact server-approved origins',()=>{
 const {verifiedPreviewUrl}=modules()('@/lib/agents/development');
 assert.equal(verifiedPreviewUrl('https://game-abc.vercel.app/'),'https://game-abc.vercel.app/');
 assert.equal(verifiedPreviewUrl('https://preview.example.test/game',['https://preview.example.test']),'https://preview.example.test/game');
 for(const url of ['http://game.vercel.app','https://vercel.app','https://game.vercel.app.attacker.test','https://foo.game.vercel.app','https://game.vercel.app@attacker.test','https://user:password@game.vercel.app','https://game.vercel.app:8443/','https://game.vercel.app/#credential','https://evil.test/','javascript:alert(1)','//game.vercel.app/'])assert.equal(verifiedPreviewUrl(url),null,url);
 assert.equal(verifiedPreviewUrl('https://evil.test/',['http://evil.test']),null);
});

test('actual preview lookup requires live same-head draft and latest successful non-production Preview deployment',async()=>{
 const projectId=randomUUID(),sha='a'.repeat(40),binding={projectId,contractHash:'b'.repeat(64),scenarioNames:['Move']};
 const task={...baseTask(),kind:'development',status:'ready',repository_id:randomUUID(),repository_full_name:'owner/repo',external:{issueNumber:2,receipt:{version:1,repository:'owner/repo',run_id:1,issue_number:2,pr_url:'https://github.com/owner/repo/pull/3',outcome:'READY',checks:{build:'success',test:'true',review:'pass',repair:'skipped',retest:'',final_review:''},tested_head_sha:sha,reviewed_head_sha:sha,projectAcceptance:{version:1,projectId,contractHash:binding.contractHash,headSha:sha,passed:true,checks:[{name:'Move',passed:true,detail:'Observed move'}]}}}};
 let head=sha,environment='Preview',production=false,status='success',url='https://game-abcdef123-team.vercel.app/',deploymentSha=sha,lookups=0,creator='vercel[bot]';
 class GitHub{
  pulls={get:async()=>({data:{state:'open',draft:true,merged:false,head:{sha:head,repo:{full_name:'owner/repo'}},base:{repo:{full_name:'owner/repo'}}}})};
  repos={listDeployments:async input=>{lookups++;assert.equal(input.sha,sha);return{data:[{id:17,sha:deploymentSha,environment,production_environment:production,creator:{login:creator}}]};},listDeploymentStatuses:async input=>{assert.equal(input.per_page,1);return{data:[{id:18,state:status,environment_url:url,creator:{login:creator}}]};}};
 }
 const db={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{repository_full_name:'owner/repo'},error:null})})})})};
 const {developmentPreview}=modules({'@octokit/rest':{Octokit:GitHub},'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db}})('@/lib/agents/development');
 const old=process.env.GITHUB_TOKEN,oldPattern=process.env.PROJECT_PREVIEW_HOST_PATTERN;process.env.PROJECT_PREVIEW_HOST_PATTERN='^game-([a-z0-9]{9})-team\\.vercel\\.app$';process.env.GITHUB_TOKEN='fixture-only';
 try{
  assert.equal((await developmentPreview(task,binding)).url,url);
  for(const change of [()=>{production=true;},()=>{production=false;environment='Production';},()=>{environment='Preview';status='failure';},()=>{status='success';url='https://evil.test';},()=>{url='https://game-git-main-team.vercel.app/';},()=>{url='https://game-abcdef123-team.vercel.app/';creator='owner';},()=>{creator='vercel[bot]';deploymentSha='c'.repeat(40);}]){change();assert.equal(await developmentPreview(task,binding),null);}
  head='d'.repeat(40);const before=lookups;await assert.rejects(developmentPreview(task,binding),/no longer matches/);assert.equal(lookups,before);
 }finally{if(old===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=old;if(oldPattern===undefined)delete process.env.PROJECT_PREVIEW_HOST_PATTERN;else process.env.PROJECT_PREVIEW_HOST_PATTERN=oldPattern;}
});

test('ordinary owner issue dispatch rejects project markers from assignment and saved instructions before any GitHub write',async()=>{
 const rows=[];
 const db={from:()=>({eq(){return this;},update:async value=>{rows.push(value);return{error:null};}})};
 let calls=0;
 class GitHub{constructor(){calls++;}}
 const {dispatchDevelopment}=modules({'@octokit/rest':{Octokit:GitHub},'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/agents/store':{agentRpc:async()=>{throw Error('Must reject before claiming dispatch');}}})('@/lib/agents/development');
 const task={...baseTask(),status:'dispatching',kind:'development'};
 for(const changed of [{input:'Implement it\n<!-- katie-project: fake -->'},{snapshot:{...task.snapshot,instructions:'<!-- katie-project: fake -->'}}])assert.equal((await dispatchDevelopment({...task,...changed})).status,'blocked');
 assert.equal(calls,0);assert.equal(rows.length,2);
});

test('root-page project specification dispatch carries the exact approved cumulative path scope',async()=>{
 const {parseProjectContext}=await import('../scripts/project-context.mjs');const contract={path:'/',scenarios:[{name:'state',steps:[{action:'expectText',selector:'#state',value:'Ready'}]}]};
 const {validateProjectPlan,digest}=modules()('@/lib/projects/contract');const plan=validateProjectPlan({name:'Root app',summary:'Root route',requirements:['Render actual state at the root route'],allowedPaths:['app/page.tsx'],milestones:[{title:'App',instruction:'Build the root app',contract}],finalContract:contract});
 const c={version:1,projectId:randomUUID(),baseSha:'a'.repeat(40),baselineSha:'a'.repeat(40),allowedPaths:plan.allowedPaths,contractHash:digest(contract),contract,scopeHash:'b'.repeat(64)},lease=randomUUID(),task={...baseTask(),kind:'development',status:'dispatching',repository_id:randomUUID(),repository_full_name:'owner/repo'};let published,admission;
 const db={rpc:async(n,a)=>{admission={n,a};return{data:true,error:null};},from(table){const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:table==='repo_sync_runs'?{repository_full_name:'owner/repo'}:table==='managed_agents'?{id:task.agent_id,actor_id:task.actor_id,config:task.snapshot}:task,error:null}),update:async p=>{Object.assign(task,p);return{error:null};}};return q;}};
 class GitHub{users={getAuthenticated:async()=>({data:{login:'owner',type:'User'}})};repos={get:async()=>({data:{owner:{login:'owner',type:'User'}}})};actions={getWorkflow:async()=>({data:{path:'.github/workflows/autonomous-development.yml',state:'active'}})};issues={create:async p=>{published=p.body;return{data:{number:7,html_url:'https://github.com/owner/repo/issues/7'}};}};}
 const old=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='fixture-only';try{const {dispatchDevelopment}=modules({'@octokit/rest':{Octokit:GitHub},'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/data/persistence-store':{getChatById:async()=>({actorId:task.actor_id})},'@/lib/projects/store':{getDevelopmentProjectContext:async()=>c}})('@/lib/agents/development');await dispatchDevelopment(task,c,lease);assert.equal(admission.n,'claim_project_dispatch');assert.equal(admission.a.p_lease,lease);const sent=parseProjectContext(published);assert.equal(sent.contract.path,'/');assert.deepEqual(sent.allowedPaths,['app/page.tsx']);assert.equal(sent.baselineSha,c.baselineSha);}finally{if(old===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=old;}
});

test('immutable Preview selection rejects branch/project aliases and absent nonce binding',()=>{const old=process.env.PROJECT_PREVIEW_HOST_PATTERN;try{process.env.PROJECT_PREVIEW_HOST_PATTERN='^game-([a-z0-9]{9})-team\\.vercel\\.app$';const {immutablePreviewUrl}=modules()('@/lib/agents/development');assert.equal(immutablePreviewUrl('https://game-abcdef123-team.vercel.app/'),'https://game-abcdef123-team.vercel.app/');for(const url of ['https://game-git-main-team.vercel.app/','https://game-team.vercel.app/','https://game-branch-team.vercel.app/'])assert.equal(immutablePreviewUrl(url),null);delete process.env.PROJECT_PREVIEW_HOST_PATTERN;assert.equal(immutablePreviewUrl('https://game-abcdef123-team.vercel.app/'),null);}finally{if(old===undefined)delete process.env.PROJECT_PREVIEW_HOST_PATTERN;else process.env.PROJECT_PREVIEW_HOST_PATTERN=old;}});
