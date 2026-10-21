import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const native=createRequire(import.meta.url);
function modules(overrides={},globals={}){
 for(const [k,v] of Object.entries(overrides))if(k.startsWith('@/'))overrides[resolve(k.slice(2))]=v;
 const cache=new Map();
 const load=name=>{
  if(name in overrides)return overrides[name];
  if(!name.startsWith('/')&&!name.startsWith('.')&&!name.startsWith('@/'))return native(name);
  let path=name.startsWith('@/')?resolve(name.slice(2)):resolve(name);
  if(path in overrides)return overrides[path];
  if(!path.endsWith('.ts'))path=existsSync(path+'.ts')?path+'.ts':path;
  if(cache.has(path))return cache.get(path);
  const exports={};cache.set(path,exports);
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  vm.runInNewContext(code,{exports,require:n=>n.startsWith('.')?load(resolve(dirname(path),n)):load(n),process,Buffer,Date,JSON,console,Set,Map,URL,TextEncoder,AbortController,AbortSignal,fetch,Response,setTimeout,clearTimeout,...globals},{filename:path});
  return exports;
 };
 return load;
}
const original={CLAUDE_API_KEY:process.env.CLAUDE_API_KEY,GOOGLE_API_KEY:process.env.GOOGLE_API_KEY};
test.before(()=>{process.env.CLAUDE_API_KEY='fixture-only';process.env.GOOGLE_API_KEY='fixture-only';});
test.after(()=>{for(const [k,v]of Object.entries(original))if(v===undefined)delete process.env[k];else process.env[k]=v;});
const unusedOpenAI={__esModule:true,default:class {constructor(){throw Error('No OpenAI inference in this fixture');}}};
const pick=(provider,model='selected-model')=>({provider:{name:provider},modelId:model,reasoning:'Task-ranked selection'});
const request={model:'selected-model',instructions:'Original complete instructions',input:[{role:'user',content:'The unchanged candidate'}],max_output_tokens:16000,text:{format:{type:'json_schema',schema:{type:'object'}}},tools:[{type:'function',name:'calculate',parameters:{type:'object'}}]};
const claude=text=>({content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:10}});
const gemini=text=>({candidates:[{content:{role:'model',parts:[{text}]},finishReason:'STOP'}],usageMetadata:{totalTokenCount:30}});

test('native counters use the identical system, schema and tools without starting inference',async()=>{
 for(const provider of ['anthropic','google']){
  const calls=[];
  const load=modules({'openai':unusedOpenAI},{fetch:async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return new Response(JSON.stringify(url.includes('count')?(provider==='anthropic'?{input_tokens:412}:{totalTokens:412}):(provider==='anthropic'?claude('ok'):gemini('ok'))));}});
  const client=load('@/lib/orchestration/bounded-provider').boundedProvider(pick(provider));
  assert.equal((await client.post('/responses/input_tokens',{body:request,timeout:5000})).input_tokens,412);
  assert.equal(calls.length,1);assert.match(calls[0].url,/count_tokens|countTokens/);
  await client.responses.create(request,{timeout:5000});
  const counted=provider==='anthropic'?calls[0].body:calls[0].body.generateContentRequest;
  const dispatched=calls[1].body;
  for(const field of provider==='anthropic'?['system','messages','tools']:['systemInstruction','contents','tools'])assert.deepEqual(counted[field],dispatched[field]);
  if(provider==='anthropic')assert.equal(counted.max_tokens,undefined);
 }
});

test('counting failure remains conservative and does not remove live-research tools',async()=>{
 const calls=[];
 const load=modules({'openai':unusedOpenAI},{fetch:async(url,init)=>{calls.push(JSON.parse(init.body));return new Response(JSON.stringify(claude('finding')));}});
 const client=load('@/lib/orchestration/bounded-provider').boundedProvider(pick('anthropic'));
 const research={...request,tools:[{type:'web_search'}]};
 await assert.rejects(client.post('/responses/input_tokens',{body:research,timeout:5000}),/search token count unavailable/);
 assert.equal(calls.length,0);
 await client.responses.create(research,{timeout:5000});assert.equal(calls[0].tools[0].max_uses,4);
});

function fixture({counts=[10000,10000],failFirst=false,incompleteFirst=false,remaining=120000,authorized=true}={}){
 const events=[],inferences=[],reservations=[],checkpoints=[];let used=0,actual=0,routes=0,denials=0;
 const perCall=new Map();
 const choices=[pick('anthropic','preferred'),pick('google','next-compatible')];
 const c={mission:{id:'mission',project_id:'project',project_kind:'specification',project_evidence:{projectProfile:'game'},objective:'Original game requirements',team:[{id:'agent',config:{research:true}}],deadline:new Date(Date.now()+600000).toISOString()},job:{id:'job',agent_id:'agent',role:'compose',instruction:'Write the complete specification',lease:'lease',lease_until:new Date(Date.now()+360000).toISOString(),payload:{}}};
 const load=modules({
  'openai':unusedOpenAI,'openai/helpers/zod':{zodTextFormat:()=>({})},
  '@/lib/projects/contract':{projectPlanSchema:{omit:()=>({})}},
  [resolve('scripts/project-game-rules.mjs')]:{GAME_RULE_CATEGORIES:['setup','action']},
  '@/lib/missions/types':{planSchema:{},calculate:()=>{throw Error('not used');}},
  '@/lib/orchestration/routing':{orchestrationChoices:async input=>{routes++;events.push({kind:'route',planning:input.planning});return choices;},orchestrationFailure:async()=> 'provider'},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   events.push({kind:name,...args});
   if(name==='reserve_mission_call'){
    if(!authorized||used+args.p_tokens>remaining){denials++;return false;}
    used+=args.p_tokens;reservations.push(args);perCall.set(args.p_call,{reserved:args.p_tokens,settled:false});return true;
   }
   if(name==='mission_call_capacity')return{authorized,remainingTokens:remaining-used,callsRemaining:10,routingCallsRemaining:20};
   if(name==='finish_mission_call'){
    const prior=perCall.get(args.p_call);if(!prior||prior.settled)return true;prior.settled=true;
    if(args.p_tokens!==null){used+=args.p_tokens-prior.reserved;actual+=args.p_tokens;}return true;
   }
   if(name==='checkpoint_mission_review_model'){checkpoints.push(args);c.job.payload.reviewModelCheckpoint={hash:args.p_hash,response:args.p_response};return true;}
   throw Error('Unexpected RPC '+name);
  }}
 },{fetch:async(url,init)=>{
   const body=JSON.parse(init.body);
   if(url.includes('count_tokens'))return new Response(JSON.stringify({input_tokens:counts[0]}));
   if(url.includes('countTokens'))return new Response(JSON.stringify({totalTokens:counts[1]}));
   inferences.push({url,body});
   if(failFirst&&inferences.length===1)throw Error('Request timed out');
   if(incompleteFirst&&inferences.length===1)return new Response(JSON.stringify({...claude('Reasoning consumed output'),stop_reason:'max_tokens'}));
   return new Response(JSON.stringify(url.includes('anthropic')?claude('Saved result'):gemini('Saved result')));
 }});
 return{c,call:load('@/lib/missions/model').missionModel,events,inferences,reservations,checkpoints,used:()=>used,actual:()=>actual,routes:()=>routes,denials:()=>denials};
}

test('timeout reservation stays charged but accurate next-provider counting leaves fallback capacity',async()=>{
 const h=fixture({failFirst:true,remaining:120000-12523});
 const result=await h.call(h.c,'Write complete JSON','e'.repeat(24000));
 assert.equal(result.provider,'google');assert.equal(h.inferences.length,2);
 assert.equal(h.reservations[0].p_tokens,10000+256+16000);
 assert.equal(h.used(),h.reservations[0].p_tokens+30,'unknown first call was not refunded');
 assert.equal(h.actual(),30);assert.equal(h.events[0].planning,true);
});

test('one unaffordable candidate is skipped without inference; next compatible model may fit',async()=>{
 const h=fixture({counts:[60000,2000],remaining:30000});
 const result=await h.call(h.c,'Write complete JSON','Evidence');
 assert.equal(result.provider,'google');assert.equal(h.denials(),1);assert.equal(h.inferences.length,1);
 assert.equal(h.reservations.length,1);assert.equal(h.reservations[0].p_model,'google:next-compatible');
});

test('lost authorization stops fallback and creates no provider spend',async()=>{
 const h=fixture({authorized:false});await assert.rejects(h.call(h.c,'Write','Evidence'),/no longer authorized/);
 assert.equal(h.inferences.length,0);assert.equal(h.denials(),1);
});

test('completed draft-blind contract is checkpointed and reused only for identical source input',async()=>{
 const h=fixture();h.c.job.role='review';
 const input='AUTHORITATIVE_USER_TURNS:\nOriginal source';
 await h.call(h.c,'Independent contract',input);
 assert.equal(h.checkpoints.length,1);const first=h.inferences.length;
 await h.call(h.c,'Independent contract',input);assert.equal(h.inferences.length,first);assert.equal(h.routes(),1);
 await h.call(h.c,'Independent contract',input+' corrected');assert.equal(h.inferences.length,first+1);assert.equal(h.routes(),2);
});

test('long-draft timeout is bounded by the original worker lease and one shared wall-clock window',()=>{
 const load=modules({'@/lib/missions/store':{}});const budget=load('@/lib/missions/request-budget');
 const now=Date.now(),claim={mission:{deadline:new Date(now+7200000).toISOString()},job:{lease_until:new Date(now+360000).toISOString()}};
 const deadline=budget.missionExecutionDeadline(claim,now);assert.equal(deadline,now+240000);
 assert.equal(budget.missionAttemptTimeout(deadline,16000,now),180000);
 assert.equal(budget.missionAttemptTimeout(deadline,16000,now+200000),35000);
 assert.equal(budget.missionExecutionDeadline(claim,now+200000),deadline,'second call cannot reset the worker clock');
});


test('review and execution use the same separate request envelopes without dropping evidence',()=>{
 const budget=modules({'@/lib/missions/store':{}})('@/lib/missions/request-budget');
 assert.equal(budget.fitsMissionEnvelope('i'.repeat(30000),'c'.repeat(30000)),true);
 assert.equal(budget.fitsMissionEnvelope('i'.repeat(48001),'candidate'),false);
 assert.equal(budget.fitsMissionEnvelope('instruction','c'.repeat(48001)),false);
 const worker=readFileSync('lib/missions/worker.ts','utf8');
 const model=readFileSync('lib/missions/model.ts','utf8');
 assert.match(worker,/fitsMissionEnvelope\(reviewFrame,reviewInput,missionInputLimit\(claim\)\)/);
 assert.match(model,/fitsMissionEnvelope\(instruction,input,missionInputLimit\(claim\)\)/);
 assert.match(worker,/validateAnswerReview\(parseJSON\(checked.text\),assessment\)/);
});


test('incomplete reviewer response charges original provider and falls back to eligible model',async()=>{
 const h=fixture({incompleteFirst:true,remaining:100000});h.c.job.role='review';
 const result=await h.call(h.c,'Review all saved requirements','Candidate and original rules');
 assert.equal(result.provider,'google');assert.equal(h.inferences.length,2);
 assert.equal(h.reservations[0].p_model,'anthropic:preferred');
 assert.equal(h.reservations[1].p_model,'google:next-compatible');
 assert.ok(h.actual()>=30,'actual usage of both attempts must be charged');
});

test('incomplete reviewer never launches next provider when no reservation fits',async()=>{
 const h=fixture({incompleteFirst:true,counts:[1000,60000],remaining:20000});h.c.job.role='review';
 await assert.rejects(h.call(h.c,'Review saved candidate','Unchanged original game brief'));
 assert.equal(h.inferences.length,1,'the first incomplete response ran and was charged; unaffordable fallback never runs');
 assert.equal(h.actual(),30);
 assert.ok(h.denials()>=1);
});


test('bounded executor filters Interactions-only models before routing or reservation while retaining ordinary Google and OpenAI Pro choices',async()=>{
 const google={name:'google',listModels:async()=>['deep-research-pro-preview-12-2025','gemini-3.1-pro']};
 const openai={name:'openai',listModels:async()=>['gpt-5.4-pro-2026-03-05']};
 let observed;
 const load=modules({
  '@/lib/providers':{getAvailableProviders:()=>[google,openai]},
  '@/lib/router/provider-health':{filterProvidersBySharedHealth:async providers=>({providers})},
  '@/lib/router/master-router':{chooseProvider:async(_,__,providers)=>{
   observed=await Promise.all(providers.map(async p=>({provider:p.name,models:await p.listModels()})));
   return{provider:google,modelId:'deep-research-pro-preview-12-2025',fallbackChain:[{provider:google,modelId:'gemini-3.1-pro'},{provider:openai,modelId:'gpt-5.4-pro-2026-03-05'}],reasoning:'Fixture'};
  }}
 });
 const choices=await load('@/lib/orchestration/routing').orchestrationChoices({objective:'Independent review',instruction:'Exact saved evidence',requestId:'fixture',review:true});
 assert.deepEqual(Array.from(observed[0].models),['gemini-3.1-pro']);
 assert.deepEqual(Array.from(choices,c=>c.modelId),['gemini-3.1-pro','gpt-5.4-pro-2026-03-05']);
 assert.throws(()=>load('@/lib/orchestration/bounded-provider').boundedProvider(pick('google','deep-research-pro-preview-12-2025')),/different orchestration transport/);
});
