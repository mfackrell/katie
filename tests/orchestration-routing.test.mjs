import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID, webcrypto } from 'node:crypto';
const native=createRequire(import.meta.url);
function modules(overrides={},globals={}){
 for(const [key,value] of Object.entries(overrides))if(key.startsWith('@/'))overrides[resolve(key.slice(2))]=value;
 const cache=new Map();
 const load=name=>{
  if(name in overrides)return overrides[name];
  if(!name.startsWith('@/')&&!name.startsWith('/')&&!name.startsWith('.'))return native(name);
  let path=name.startsWith('@/')?resolve(name.slice(2)):resolve(name);
  if(path.endsWith('.mjs'))return native(path);
  if(!path.endsWith('.ts'))path=existsSync(path+'.ts')?path+'.ts':resolve(path,'index.ts');
  if(cache.has(path))return cache.get(path);
  const exports={};cache.set(path,exports);
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  vm.runInNewContext(code,{exports,require:n=>n.startsWith('.')?load(resolve(dirname(path),n)):load(n),process,Buffer,Date,JSON,console,Set,Map,URL,URLSearchParams,TextEncoder,TextDecoder,Request,Response,Headers,ReadableStream,AbortController,AbortSignal,File,Blob,fetch,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,...globals},{filename:path});
  return exports;
 };
 return load;
}
const config={research:true,instructions:'Use evidence',development:false};
const claim=(role='work')=>({mission:{id:'mission',objective:'Assess the liquidity implications of industrial inventory',team:[{id:'agent',config}],deadline:new Date(Date.now()+600000).toISOString()},job:{id:'job',agent_id:'agent',role,instruction:'Analyze working capital',lease:'lease',lease_until:new Date(Date.now()+600000).toISOString()}});
const choice=(provider,model)=>({provider:{name:provider},modelId:model,reasoning:'Best capability for the actual assignment'});
function harness(choices,replies,reserve=true){
 const calls=[],ledger=[];
 const load=modules({
  '@/lib/orchestration/routing':{orchestrationChoices:async()=>choices,orchestrationFailure:async(_,e)=>/429|credits/i.test(e.message)?'provider':'model'},
  '@/lib/missions/store':{rpc:async(name,args)=>{ledger.push({name,...args});return name==='reserve_mission_call'?reserve:true;}}
 },{fetch:async(url,request)=>{
  if(url.endsWith('/count_tokens'))return new Response(JSON.stringify({input_tokens:200}),{status:200});
  if(url.endsWith(':countTokens'))return new Response(JSON.stringify({totalTokens:200}),{status:200});
  calls.push({url,body:JSON.parse(request.body),signal:request.signal});const reply=replies.shift();if(reply instanceof Error)throw reply;return new Response(JSON.stringify(reply),{status:200});
 }});
 return{run:load('@/lib/missions/model').missionModel,calls,ledger};
}
const anthropic=(text,extra={})=>({content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:10},...extra});
const google=(text)=>({candidates:[{content:{role:'model',parts:[{text}]},finishReason:'STOP'}],usageMetadata:{totalTokenCount:30}});
const originalKeys={CLAUDE_API_KEY:process.env.CLAUDE_API_KEY,GOOGLE_API_KEY:process.env.GOOGLE_API_KEY,OPENAI_API_KEY:process.env.OPENAI_API_KEY};
test.before(()=>{process.env.CLAUDE_API_KEY='transport-test';process.env.GOOGLE_API_KEY='transport-test';delete process.env.OPENAI_API_KEY;});
test.after(()=>{for(const [k,v]of Object.entries(originalKeys)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});

test('EO and child stages use task routing with original scope and provider-diverse fallback, without provider pins',async()=>{
 const seen=[],providers=['anthropic','google','openai','grok'].map(name=>({name,listModels:async()=>name==='google'?['best-writer']:name==='anthropic'?['deep-reasoner','smaller-reasoner']:['alternative']}));
 const load=modules({
  '@/lib/providers':{getAvailableProviders:()=>providers},
  '@/lib/router/provider-health':{filterProvidersBySharedHealth:async p=>({providers:p})},
  '@/lib/router/master-router':{chooseProvider:async(prompt,context,p,options)=>{seen.push({prompt,context,p,options});return{provider:providers[1],modelId:'best-writer',fallbackChain:[{provider:providers[0],modelId:'deep-reasoner'},{provider:providers[0],modelId:'smaller-reasoner'},{provider:providers[2],modelId:'alternative'}],reasoning:'Task-specific decision'};}}
 });
 const route=load('@/lib/orchestration/routing').orchestrationChoices;
 const choices=await route({objective:'Original user objective',instruction:'Scoped delegated writing',requestId:'req'});
 assert.equal(choices[0].modelId,'best-writer');assert.equal(choices[0].provider.name,'google');
 assert.deepEqual(Array.from(choices,c=>c.modelId),['best-writer','deep-reasoner','alternative','smaller-reasoner']);
 assert.match(seen[0].prompt,/Original user objective[\s\S]*Scoped delegated writing/);
 assert.equal(seen[0].options.diverseFallbackProviders,true);assert.equal(seen[0].options.decisionCandidatesPerProvider,4);
 await route({objective:'Audit',instruction:'Independent review',requestId:'review',review:true});
 assert.equal(seen[1].options.requestIntent,'assistant-reflection');
 await route({objective:'Audit',instruction:'Delegate',requestId:'plan',planning:true});assert.equal(seen[2].options.requestIntent,'architecture-review');
});

test('mission executes on Anthropic without any OpenAI key and saves actual provider/model and usage',async()=>{
 const h=harness([choice('anthropic','selected-opus')],[anthropic('Liquidity analysis')]);
 const result=await h.run(claim(),'Analyze','Supplied evidence');
 assert.equal(result.text,'Liquidity analysis');assert.equal(result.provider,'anthropic');assert.equal(result.model,'selected-opus');
 assert.equal(h.calls[0].body.model,'selected-opus');assert.equal(h.calls[0].body.max_tokens,3000);
 assert.ok(h.calls[0].signal);assert.equal(h.ledger[0].p_model,'anthropic:selected-opus');
 assert.equal(h.ledger[1].p_tokens,30);assert.match(result.routingReason,/Best capability/);
});

test('billing failure falls back across providers within the same job/lease and accounts for each attempt',async()=>{
 const h=harness([choice('anthropic','selected-opus'),choice('google','selected-gemini'),choice('anthropic','smaller-model')],[Error('429 no credits remaining'),google('Completed by Gemini')]);
 const c=claim(),result=await h.run(c,'Analyze','Evidence');
 assert.equal(result.provider,'google');assert.equal(result.text,'Completed by Gemini');assert.equal(h.calls.length,2);
 const reservations=h.ledger.filter(x=>x.name==='reserve_mission_call');assert.equal(reservations.length,2);
 for(const call of reservations){assert.equal(call.p_id,c.job.id);assert.equal(call.p_lease,c.job.lease);}
 assert.deepEqual(Array.from(result.attemptedModels),['anthropic:selected-opus','google:selected-gemini']);
 assert.equal(h.ledger.filter(x=>x.name==='finish_mission_call').length,2);
});

test('budget denial prevents every native provider from dispatching or falling back',async()=>{
 const h=harness([choice('anthropic','model-a'),choice('google','model-b')],[],false);
 await assert.rejects(h.run(claim(),'Analyze','Evidence'),/allowance exhausted/);
 assert.equal(h.calls.length,0);assert.equal(h.ledger.length,2);
 assert.deepEqual(h.ledger.map(x=>x.name),['reserve_mission_call','mission_call_capacity']);
});

test('Anthropic calculator executes deterministic typed tools and returns native tool results',async()=>{
 const h=harness([choice('anthropic','math-model')],[anthropic('',{stop_reason:'tool_use',content:[{type:'tool_use',id:'calc-1',name:'calculate',input:{operation:'multiply',values:[12,175]}}]}),anthropic('Cost is 2100.')]);
 const result=await h.run(claim(),'Analyze','Costs','calculate');
 assert.equal(result.calculations[0].result,2100);
 const messages=h.calls[1].body.messages;assert.equal(messages[1].content[0].id,'calc-1');
 assert.equal(messages[2].content[0].tool_use_id,'calc-1');assert.match(messages[2].content[0].content,/2100/);
 assert.equal(h.ledger.filter(x=>x.name==='reserve_mission_call').length,2);
});

test('Gemini calculator preserves native function context and call IDs',async()=>{
 const native={role:'model',parts:[{thoughtSignature:'native-signature',functionCall:{id:'native-call',name:'calculate',args:{operation:'add',values:[2,3]}}}]};
 const h=harness([choice('google','math-gemini')],[{candidates:[{content:native,finishReason:'STOP'}],usageMetadata:{totalTokenCount:20}},google('Total is 5.')]);
 const result=await h.run(claim(),'Analyze','Inputs','calculate');assert.equal(result.calculations[0].result,5);
 assert.deepEqual(h.calls[1].body.contents[1],native);
 const response=h.calls[1].body.contents[2].parts[0].functionResponse;assert.equal(response.id,'native-call');assert.equal(response.response.result,5);
});

test('Anthropic live research requires native citations and retains enforced search cap',async()=>{
 const h=harness([choice('anthropic','research-model')],[anthropic('Supported finding',{content:[{type:'text',text:'Supported finding',citations:[{type:'web_search_result_location',url:'https://primary.example/report',title:'Primary report'}]}]})]);
 const result=await h.run(claim(),'Research','Find evidence','research');assert.equal(result.sources[0].url,'https://primary.example/report');
 assert.equal(h.calls[0].body.tools[0].max_uses,4);
 const bad=harness([choice('anthropic','research-model')],[anthropic('Trust this made-up URL: https://primary.example/report')]);
 await assert.rejects(bad.run(claim(),'Research','Find evidence','research'),/no cited live sources/);
});

test('explicit routing policy is inherited by factory-created orchestrators and all stages use the shared runner',()=>{
 const factory=readFileSync('lib/executive/factory-runtime.ts','utf8');
 assert.match(factory,/scope:'every-stage-and-child-mission'/);assert.match(factory,/modelRouting:routingPolicy/);
 assert.match(readFileSync('lib/missions/model.ts','utf8'),/orchestrationChoices\(/);
 const planner=readFileSync('lib/executive/planner.ts','utf8');assert.match(planner,/orchestrationChoices\(/);assert.doesNotMatch(planner,/selectControlPlaneDecisionModels/);
});

test('routing-model inference is bounded and accounted before dispatch',async()=>{
 const providers=[{name:'anthropic',listModels:async()=>['router-model','worker-model']}],events=[];
 const load=modules({
  '@/lib/providers':{getAvailableProviders:()=>providers},
  '@/lib/router/provider-health':{filterProvidersBySharedHealth:async p=>({providers:p})},
  '@/lib/router/master-router':{chooseProvider:async(_,__,p)=>{
   const response=await p[0].generate({modelId:'router-model',persona:'Select',history:[],summary:'',user:'Candidates'});
   assert.equal(response.text,'Decision');
   return{provider:p[0],modelId:'worker-model',fallbackChain:[],reasoning:'selected'};
  }},
  '@/lib/orchestration/bounded-provider':{boundedProvider:()=>({responses:{create:async(request,options)=>{events.push('dispatch');assert.equal(request.max_output_tokens,2000);assert.equal(options.timeout,30000);return{status:'completed',output_text:'Decision',usage:{total_tokens:25}};}}})}
 });
 const accounting={reserve:async(model,tokens)=>{events.push('reserve');assert.equal(model,'anthropic:router-model');assert.ok(tokens>2000);return'call-id';},finish:async(id,tokens)=>{events.push('finish');assert.equal(id,'call-id');assert.equal(tokens,25);}};
 await load('@/lib/orchestration/routing').orchestrationChoices({objective:'Mission',instruction:'Work',requestId:'req',accounting});
 assert.deepEqual(events,['reserve','dispatch','finish']);
});

test('no eligible provider blocks explicitly and oversized context never starts routing or inference',async()=>{
 const h=harness([],[]);await assert.rejects(h.run(claim(),'Analyze','Evidence'),/No eligible orchestration model/);
 const large=harness([choice('anthropic','model')],[]);await assert.rejects(large.run(claim(),'Analyze','x'.repeat(48001)),/bounded context/);assert.equal(large.calls.length,0);assert.equal(large.ledger.length,0);
});


test('large routing inventories keep every provider without exhausting a mission before its first call',()=>{
 const shortlist=modules()('@/lib/router/candidate-shortlist').shortlistDecisionCandidates;
 const candidates=Array.from({length:151},(_,i)=>({providerName:i<100?'openai':i<125?'google':i<139?'anthropic':'grok',modelId:'ranked-'+i,capabilities:'source metadata '.repeat(70)}));
 const bounded=shortlist(candidates,4);
 assert.equal(bounded.length,16);assert.equal(new Set(bounded.map(c=>c.providerName)).size,4);
 for(const p of ['openai','google','anthropic','grok'])assert.deepEqual(Array.from(bounded.filter(c=>c.providerName===p),c=>c.modelId),candidates.filter(c=>c.providerName===p).slice(0,4).map(c=>c.modelId));
 const reserve=Buffer.byteLength(JSON.stringify(bounded))+12000+2000;
 assert.ok(reserve<60000,'bounded routing reservation fits the unchanged initial mission allowance');
 assert.equal(shortlist(candidates),candidates,'ordinary routing keeps its existing inventory policy');
});

test('pre-generation HTTP rejection settles at zero while timeout retains the original hold',async()=>{
 for(const [status,expected] of [[400,0],[404,0],[429,0],[408,null],[503,null]]){
  const error=Object.assign(Error(status===400?'Unsupported value in request':'Request failed'),{status});
  const h=harness([choice('anthropic','first'),choice('google','second')],[error,google('Recovered')]);
  const result=await h.run(claim(),'Analyze','Evidence');assert.equal(result.text,'Recovered');
  assert.equal(h.ledger.find(x=>x.name==='finish_mission_call').p_tokens,expected);
 }
});
test('Gemini sends strict calculator schema through the JSON Schema field',async()=>{
 const h=harness([choice('google','calculator')],[google('No arithmetic needed')]);
 await h.run(claim(),'Analyze','Qualitative evidence','calculate');
 const declaration=h.calls[0].body.tools[0].functionDeclarations[0];
 assert.equal(declaration.parameters,undefined);assert.equal(declaration.parametersJsonSchema.additionalProperties,false);
});
test('bounded transport excludes incompatible agent endpoints without pinning a model',()=>{
 const {boundedModelSupported,rejectedBeforeInference}=modules()('@/lib/orchestration/request-rejection');
 assert.equal(boundedModelSupported('google','deep-research-pro-preview-12-2025'),false);
 assert.equal(boundedModelSupported('google','models/deep-research-pro-preview-12-2025'),false);
 assert.equal(boundedModelSupported('google','gemini-pro-latest'),true);
 assert.equal(boundedModelSupported('openai','task-selected-model'),true);
 for(const status of [408,409,500,503])assert.equal(rejectedBeforeInference({status,message:'Unknown execution'}),false);
 assert.equal(rejectedBeforeInference({status:400,message:'Unknown failure'}),false);
 assert.equal(rejectedBeforeInference(Error('404 mentioned only in an untrusted log')),false);
});
test('autonomous decisions and fallbacks are restricted to current provider inventories, not stale registry entries',async()=>{
 const providers=[{name:'openai',listModels:async()=>['accessible-model']},{name:'google',listModels:async()=>['models/gemini-current','models/deep-research-pro-preview']}];let seen;
 const load=modules({'@/lib/providers':{getAvailableProviders:()=>providers},'@/lib/router/provider-health':{filterProvidersBySharedHealth:async p=>({providers:p})},'@/lib/router/master-router':{chooseProvider:async(_,__,p,options)=>{
  seen=options;assert.equal(options.candidateAllowed('openai','stale-unavailable-model'),false);assert.equal(options.candidateAllowed('google','deep-research-pro-preview'),false);assert.equal(options.candidateAllowed('openai','accessible-model'),true);
  assert.deepEqual(Array.from(await p[1].listModels()),['gemini-current']);
  return{provider:p[0],modelId:'stale-unavailable-model',fallbackChain:[{provider:p[0],modelId:'accessible-model'},{provider:p[1],modelId:'gemini-current'}],reasoning:'Capability-ranked inventory'};
 }}});
 const choices=await load('@/lib/orchestration/routing').orchestrationChoices({objective:'Review actual evidence',instruction:'Independent assessment',requestId:'inventory-test'});
 assert.ok(seen);assert.deepEqual(Array.from(choices,c=>c.modelId),['accessible-model','gemini-current']);
});
test('failed or empty live model discovery cannot silently reuse stale registry candidates',async()=>{
 let decisions=0;const providers=[{name:'openai',listModels:async()=>{throw Error('Discovery unavailable');}},{name:'google',listModels:async()=>[]}];
 const load=modules({'@/lib/providers':{getAvailableProviders:()=>providers},'@/lib/router/provider-health':{filterProvidersBySharedHealth:async p=>({providers:p})},'@/lib/router/master-router':{chooseProvider:async()=>{decisions++;throw Error('Must not guess');}}});
 await assert.rejects(load('@/lib/orchestration/routing').orchestrationChoices({objective:'Review',instruction:'Assess',requestId:'failed-discovery'}),/No connected provider/);assert.equal(decisions,0);
});
test('truncated native generation can fall back without treating partial text as an accepted result',async()=>{
 const h=harness([choice('anthropic','deep-reasoner'),choice('google','compatible-reasoner')],[anthropic('Incomplete source analysis',{stop_reason:'max_tokens'}),google('Complete source analysis')]);
 const r=await h.run(claim(),'Analyze','Evidence');assert.equal(r.text,'Complete source analysis');assert.equal(r.provider,'google');
 assert.equal(h.ledger.filter(x=>x.name==='reserve_mission_call').length,2);
 assert.equal(h.ledger.filter(x=>x.name==='finish_mission_call'&&x.p_tokens===30).length,2);
});
test('Grok search retains its hard call cap and omits OpenAI-only search context settings',async()=>{
 const old=process.env.GROK_API_KEY;process.env.GROK_API_KEY='fixture-only';let sent;
 try{
  class Client{responses={create:async body=>{sent=body;return{status:'completed',output_text:'Source-grounded result',output:[]};}};}
  const {boundedProvider}=modules({'openai':{__esModule:true,default:Client}})('@/lib/orchestration/bounded-provider');
  await boundedProvider(choice('grok','current-grok')).responses.create({model:'current-grok',instructions:'Research',input:[{role:'user',content:'Find a primary source'}],max_output_tokens:3000,tools:[{type:'web_search',search_context_size:'low'}],max_tool_calls:4},{timeout:1000});
  assert.equal(sent.tools[0].type,'web_search');assert.equal(sent.tools[0].search_context_size,undefined);assert.equal(sent.max_tool_calls,4);
 }finally{if(old===undefined)delete process.env.GROK_API_KEY;else process.env.GROK_API_KEY=old;}
});
