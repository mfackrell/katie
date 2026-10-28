import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { runModelTools, type ToolAudit, type ScopedTool } from '../lib/tools/loop';
import { createSelfInspectionTools, runSelfInspection } from '../lib/tools/self-inspection';
import { nativeToolTurn } from '../lib/providers/native-tools';
import { authorizeSelfToolCaller } from '../lib/tools/authorization';
import type { LlmProvider } from '../lib/providers/types';
import type { ToolTurn } from '../lib/tools/types';

const params = {name:'Katie',persona:'help',summary:'',user:'inspect your source',history:[],modelId:'selected-model'};
const result = (calls: ToolTurn['calls'] = []): ToolTurn => ({response:{text:calls.length?'':'Verified evidence',provider:'grok',model:'actual-model'},calls});
const call = {id:'c1',name:'read',arguments:{}};
const tool: ScopedTool = {name:'read',description:'read',parameters:{type:'object'},validate:z.object({}).strict(),execute:async()=>({sha:'a'.repeat(40)})};
function provider(turns: ToolTurn[]): LlmProvider {
  return {name:'grok',listModels:async()=>[],generate:async()=>{throw Error('must use native tools');},generateToolTurn:async()=>{const t=turns.shift();if(!t)throw Error('excess turns');return t;}};
}
const base = {params,deadlineMs:Date.now()+60000,tools:[tool],authorize:async()=>{}};

test('model executes validated tools with durable ordered audit and actual model provenance',async()=>{
  const records:ToolAudit[]=[];let authorized=0;
  const response=await runModelTools({...base,provider:provider([result([call]),result()]),authorize:async()=>{authorized++;},audit:async r=>{records.push(r);}});
  assert.equal(response.model,'actual-model');assert.equal(response.provider,'grok');
  assert.deepEqual(records.map(r=>r.phase),['started','completed']);assert.equal(authorized,3);
});

test('audit failure prevents execution; authorization loss prevents later calls',async()=>{
  let executed=0;
  const tools=[{...tool,execute:async()=>{executed++;return {};}}];
  await assert.rejects(runModelTools({...base,tools,provider:provider([result([call])]),audit:async()=>{throw Error('audit unavailable');}}),/audit unavailable/);
  assert.equal(executed,0);let n=0;
  await assert.rejects(runModelTools({...base,tools,provider:provider([result([call])]),authorize:async()=>{if(++n===2)throw Error('wrong actor');},audit:async()=>{}}),/wrong actor/);
  assert.equal(executed,0);
});

test('invalid arguments are blocked without executing or recording unknown secret arguments',async()=>{
  let executed=0;const records:ToolAudit[]=[];
  await runModelTools({...base,tools:[{...tool,execute:async()=>{executed++;}}],provider:provider([result([{...call,arguments:{token:'secret'}}]),result()]),audit:async r=>{records.push(r);}});
  assert.equal(executed,0);assert.equal(records[0].phase,'blocked');assert.ok(!JSON.stringify(records).includes('secret'));
});

test('bounded loop stops runaway calls and rejects prose with no inspection evidence',async()=>{
  await assert.rejects(runModelTools({...base,provider:provider([result()]),audit:async()=>{}}),/no tool evidence/);
  await assert.rejects(runModelTools({...base,maxCalls:1,provider:provider([result([call,call])]),audit:async()=>{}}),/budget reached/);
  await assert.rejects(runModelTools({...base,deadlineMs:0,provider:provider([]),audit:async()=>{}}),/deadline/);
});

test('own GitHub tools pin once and never accept repository, ref, traversal or credential paths',async()=>{
  const old=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='test-token';
  const urls:string[]=[];const sha='a'.repeat(40);
  try {
    const tools=createSelfInspectionTools({actorId:'a',chatId:'c',requestId:'r',fetchJson:async url=>{urls.push(url);
      if(url.endsWith('commits/HEAD'))return {sha};
      if(url.includes('git/trees'))return {tree:[{type:'blob',path:'lib/a.ts'}]};
      return {size:5,encoding:'base64',content:Buffer.from('hello').toString('base64'),sha:'blob'};
    }});
    const read=tools.find(t=>t.name==='github_read_file')!;
    for(const path of ['../secret','.env','.env.local','lib/../secret','.aws/config','.git/config','lib/secrets.json','.ssh/id_ed25519','config/service-account.json','tokens.txt'])assert.equal(read.validate.safeParse({path}).success,false,path);
    assert.equal(read.validate.safeParse({path:'lib/a.ts',ref:'other',repository:'evil/repo'}).success,false);
    await tools[0].execute({},AbortSignal.timeout(1000));
    const file=await read.execute({path:'lib/a.ts'},AbortSignal.timeout(1000)) as {sha:string;text:string};
    assert.equal(file.sha,sha);assert.equal(file.text,'hello');assert.equal(urls.filter(u=>u.endsWith('commits/HEAD')).length,1);
    assert.ok(urls.every(u=>u.startsWith('https://api.github.com/repos/mfackrell/katie/')));
    assert.ok(urls.at(-1)?.endsWith(`?ref=${sha}`));
  } finally {if(old===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=old;}
});

test('missing Vercel token blocks with precise setup requirement and no network call',async()=>{
  const old=process.env.VERCEL_TOKEN;delete process.env.VERCEL_TOKEN;
  try {
    const tools=createSelfInspectionTools({actorId:'a',chatId:'c',requestId:'r',fetchJson:async()=>{throw Error('no fetch');}});
    const receipt=await tools.find(t=>t.name==='vercel_deployments')!.execute({},AbortSignal.timeout(1000));
    assert.match(JSON.stringify(receipt),/blocked/);assert.match(JSON.stringify(receipt),/VERCEL_TOKEN/);
  } finally {if(old!==undefined)process.env.VERCEL_TOKEN=old;}
});

for(const name of ['openai','grok','anthropic','google'] as const)test(`${name} native tool transport preserves schema, selected model and tool results`,async()=>{
  const saved=globalThis.fetch;const bodies:any[]=[];
  globalThis.fetch=async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify(name==='anthropic'
    ?{model:'actual',content:[{type:'tool_use',id:'c1',name:'read',input:{}}]}
    :name==='google'?{modelVersion:'actual',candidates:[{content:{parts:[{functionCall:{name:'read',args:{}},thoughtSignature:'opaque-signature'}]}}]}
    :{model:'actual',choices:[{message:{tool_calls:[{id:'c1',function:{name:'read',arguments:'{}'}}]}}]}));};
  try {
    const p={modelId:'selected-model',system:'instructions',messages:[{role:'user' as const,text:'inspect'}],tools:[{name:'read',description:'read',parameters:{type:'object',properties:{},additionalProperties:false}}],signal:AbortSignal.timeout(1000)};
    const turn=await nativeToolTurn(name,'test-key',p);
    assert.equal(turn.calls[0].name,'read');assert.equal(turn.response.model,'actual');assert.equal(turn.response.provider,name);
    assert.ok(JSON.stringify(bodies[0]).includes('additionalProperties'));
    await nativeToolTurn(name,'test-key',{...p,messages:[...p.messages,{role:'assistant',text:'',calls:turn.calls,nativeParts:turn.nativeParts},{role:'tool',callId:turn.calls[0].id,text:'receipt'}]});
    assert.ok(JSON.stringify(bodies[1]).includes('receipt'));
    if(name==='google')assert.ok(JSON.stringify(bodies[1]).includes('opaque-signature'));
    else assert.equal(bodies[0].model,'selected-model');
  } finally {globalThis.fetch=saved;}
});

test('upstream credential-bearing errors are not forwarded',async()=>{
  const saved=globalThis.fetch;globalThis.fetch=async()=>new Response('secret-token-value',{status:401});
  try {await assert.rejects(nativeToolTurn('grok','test-key',{modelId:'selected',system:'',messages:[],tools:[],signal:AbortSignal.timeout(1000)}),e=>e instanceof Error && e.message.includes('401')&&!e.message.includes('secret-token'));}
  finally {globalThis.fetch=saved;}
});

test('OpenAI reasoning models use Responses tools and preserve reasoning items on continuation',async()=>{
  const saved=globalThis.fetch;const urls:string[]=[];const bodies:any[]=[];
  globalThis.fetch=async(url,init)=>{urls.push(String(url));bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({model:'gpt-5-actual',output:[{type:'reasoning',id:'reasoning-1',summary:[]},{type:'function_call',call_id:'call-1',name:'read',arguments:'{}'}]}));};
  try {
    const p={modelId:'gpt-5-codex',system:'instructions',messages:[{role:'user' as const,text:'inspect'}],tools:[{name:'read',description:'read',parameters:{type:'object'}}],signal:AbortSignal.timeout(1000)};
    const turn=await nativeToolTurn('openai','test-key',p);
    await nativeToolTurn('openai','test-key',{...p,messages:[...p.messages,{role:'assistant',text:'',calls:turn.calls,nativeParts:turn.nativeParts},{role:'tool',text:'receipt',callId:'call-1'}]});
    assert.ok(urls.every(u=>u.endsWith('/v1/responses')));assert.equal(turn.response.model,'gpt-5-actual');
    assert.ok(bodies[1].input.some((i:any)=>i.id==='reasoning-1'));
    assert.ok(bodies[1].input.some((i:any)=>i.type==='function_call_output'&&i.call_id==='call-1'));
  } finally {globalThis.fetch=saved;}
});

test('Vercel verification requires the bound project, READY state, source SHA and production alias',async()=>{
  const old={token:process.env.VERCEL_TOKEN,project:process.env.VERCEL_PROJECT_ID};
  process.env.VERCEL_TOKEN='test-key';process.env.VERCEL_PROJECT_ID='prj_katie';
  try {
    for(const mismatch of ['none','project','state','sha','alias','staleAlias','repository']){
      const tools=createSelfInspectionTools({actorId:'a',chatId:'c',requestId:'r',fetchJson:async url=>{
        if(url.includes('/v6/'))return {deployments:[{uid:'dpl_test',target:'production',state:'READY'}]};
        if(url.includes('/v4/aliases/'))return {projectId:'prj_katie',deployment:{id:mismatch==='staleAlias'?'other':'dpl_test'}};
        if(url.includes('/aliases'))return {aliases:[{alias:mismatch==='alias'?'other.vercel.app':'katie-mu.vercel.app'}]};
        return {projectId:mismatch==='project'?'other':'prj_katie',readyState:mismatch==='state'?'ERROR':'READY',target:'production',meta:{githubCommitOrg:'mfackrell',githubCommitRepo:mismatch==='repository'?'other':'katie',githubCommitSha:mismatch==='sha'?'invalid':'a'.repeat(40)}};
      }});
      const receipt=await tools.find(t=>t.name==='vercel_production')!.execute({},AbortSignal.timeout(1000)) as {status:string};
      assert.equal(receipt.status,mismatch==='none'?'verified':'blocked',mismatch);
    }
  } finally {
    if(old.token===undefined)delete process.env.VERCEL_TOKEN;else process.env.VERCEL_TOKEN=old.token;
    if(old.project===undefined)delete process.env.VERCEL_PROJECT_ID;else process.env.VERCEL_PROJECT_ID=old.project;
  }
});

test('runtime denies request, actor identity, executive, chat mismatch and database failures before native execution',async()=>{
  const saved=globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__;
  const savedFetch=globalThis.fetch;
  const savedEnv={...process.env};
  process.env.KATIE_SELF_ACTOR_ID='a';
  process.env.NEXT_PUBLIC_SUPABASE_URL='https://auth.example.test';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='test-anon';
  const owner='11111111-1111-4111-8111-111111111111';
  globalThis.fetch=async()=>Response.json({id:owner});
  try {
    for(const mismatch of ['requestActor','requestChat','chatActor','identity','executive','status','database']){
      let modelCalls=0;
      globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__={from:(table:string)=>{
        const query:any={select:()=>query,eq:()=>query,maybeSingle:async()=>({error:mismatch==='database'?{message:'db error'}:null,data:
          table==='self_tool_owner_grants'?{owner_id:owner}:table==='chat_requests'?{actor_id:mismatch==='requestActor'?'other':'a',chat_id:mismatch==='requestChat'?'other':'c',status:mismatch==='status'?'completed':'processing'}
          :table==='actors'?{name:mismatch==='identity'?'Other':'Katie',actor_kind:mismatch==='executive'?'executive':'standard'}
          :{actor_id:mismatch==='chatActor'?'other':'a'}})};return query;
      }} as unknown as NonNullable<typeof globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__>;
      await assert.rejects(runSelfInspection({request:{headers:new Headers({authorization:'Bearer test-session'})},actorId:'a',chatId:'c',requestId:'r',params,deadlineMs:Date.now()+60000,
        provider:{...provider([]),generateToolTurn:async()=>{modelCalls++;return result();}}}),/authorization denied/);
      assert.equal(modelCalls,0,mismatch);
    }
  } finally {globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__=saved;globalThis.fetch=savedFetch;process.env=savedEnv;}
});

test('self tools authenticate the caller and reject absent, forged, cross-owner and cross-chat grants',async()=>{
  const saved=globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__, savedFetch=globalThis.fetch, savedEnv={...process.env};
  const owner='11111111-1111-4111-8111-111111111111';
  process.env.KATIE_SELF_ACTOR_ID='a';process.env.NEXT_PUBLIC_SUPABASE_URL='https://auth.example.test';process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='test-anon';
  try {
    for(const scenario of ['absent','forged','crossOwner','crossChat','unboundActor','revoked','valid']) {
      let authCalls=0;const filters:Record<string,unknown>={};
      globalThis.fetch=async(url,init)=>{authCalls++;assert.equal(String(url),'https://auth.example.test/auth/v1/user');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer test-session');return scenario==='forged'?new Response(null,{status:401}):Response.json({id:owner});};
      globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__={from:(table:string)=>{
        assert.equal(table,'self_tool_owner_grants');
        const q:any={select:()=>q,eq:(key:string,value:unknown)=>{filters[key]=value;return q;},maybeSingle:async()=>({error:null,data:['crossOwner','crossChat','revoked'].includes(scenario)?null:{owner_id:owner}})};return q;
      }} as unknown as NonNullable<typeof saved>;
      const request={headers:new Headers(scenario==='absent'?{}:{authorization:'Bearer test-session'})};
      const attempt=authorizeSelfToolCaller(request,scenario==='unboundActor'?'other':'a','c');
      if(scenario==='valid')assert.equal(await attempt,owner);else await assert.rejects(attempt,/authorization denied/);
      if(['crossOwner','crossChat','revoked','valid'].includes(scenario))assert.deepEqual(filters,{owner_id:owner,actor_id:'a',chat_id:'c'});
      if(['absent','unboundActor'].includes(scenario))assert.equal(authCalls,0);
    }
  } finally {globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__=saved;globalThis.fetch=savedFetch;process.env=savedEnv;}
});

test('material changes remain visibly blocked and never invoke external writes',async()=>{
  let calls=0;
  const tools=createSelfInspectionTools({actorId:'a',chatId:'c',requestId:'r',fetchJson:async()=>{calls++;return {};}});
  for(const resource of ['github','supabase','vercel']){
    const receipt=await tools.find(t=>t.name==='change_capability')!.execute({resource},AbortSignal.timeout(1000)) as {status:string};
    assert.equal(receipt.status,'blocked');
  }
  assert.equal(calls,0);
});

test('resumed attempts share the request tool budget instead of resetting spend guards',async()=>{
  let executed=0;
  await assert.rejects(runModelTools({...base,sequenceStart:8,tools:[{...tool,execute:async()=>{executed++;}}],provider:provider([result([call])]),audit:async()=>{}}),/budget reached/);
  assert.equal(executed,0);
});

test('native adapter, loop and pinned source reader integrate across a real tool-result continuation',async()=>{
  const {OpenAiProvider}=await import('../lib/providers/openai-provider');
  const savedFetch=globalThis.fetch, savedToken=process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN='test-token';let turn=0;const sha='b'.repeat(40);const records:ToolAudit[]=[];
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));turn++;
    if(turn===1)return new Response(JSON.stringify({model:'actual-inspector',choices:[{message:{tool_calls:[{id:'c1',function:{name:'github_read_file',arguments:JSON.stringify({path:'lib/a.ts'})}}]}}]}));
    const receipt=JSON.parse(body.messages.at(-1).content);
    assert.equal(receipt.sha,sha);assert.equal(receipt.text,'export const value = 1;');
    return new Response(JSON.stringify({model:'actual-inspector',choices:[{message:{content:`Inspected lib/a.ts at ${sha}`}}]}));
  };
  try {
    const tools=createSelfInspectionTools({actorId:'a',chatId:'c',requestId:'r',fetchJson:async url=>url.endsWith('commits/HEAD')?{sha}
      :{size:23,encoding:'base64',sha:'blob',content:Buffer.from('export const value = 1;').toString('base64')}});
    const response=await runModelTools({...base,tools,provider:new OpenAiProvider('test-key'),audit:async r=>{records.push(r);}});
    assert.equal(response.model,'actual-inspector');assert.ok(response.text.includes(sha));
    assert.equal(turn,2);assert.deepEqual(records.map(r=>r.phase),['started','completed']);
  } finally {globalThis.fetch=savedFetch;if(savedToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=savedToken;}
});

test('a provider that ignores cancellation cannot hold the loop beyond its deadline',async()=>{
  const keepAlive=setInterval(()=>{},1000);
  try {
    await assert.rejects(runModelTools({...base,deadlineMs:Date.now()+30,provider:{...provider([]),generateToolTurn:async()=>new Promise(()=>{})},audit:async()=>{}}),/timed out|deadline/);
  } finally {clearInterval(keepAlive);}
});

test('native GPT chat-latest uses chat completions; HTTP status survives safe provider diagnostics',async()=>{
  const originalFetch=globalThis.fetch;
  const routes:string[]=[];
  globalThis.fetch=(async(input:RequestInfo|URL)=>{
    routes.push(String(input));
    return new Response('',{status:404});
  }) as typeof fetch;
  const options={modelId:'gpt-5-chat-latest',system:'test',signal:new AbortController().signal,messages:[{role:'user',text:'hello'}],tools:[]};
  try {
    await assert.rejects(nativeToolTurn('openai','test',options as Parameters<typeof nativeToolTurn>[2]),(error:unknown)=>{
      assert.equal((error as {status:number}).status,404);
      assert.equal((error as {code:string}).code,'upstream_model_or_endpoint_not_found');
      return true;
    });
    assert.equal(routes[0],'https://api.openai.com/v1/chat/completions');
    await assert.rejects(nativeToolTurn('google','test',{...options,modelId:'gemini-pro-latest'} as Parameters<typeof nativeToolTurn>[2]),(error:unknown)=>{
      assert.equal((error as {status:number}).status,404);
      return true;
    });
    assert.match(routes[1],/generativelanguage.googleapis.com/);
  } finally {globalThis.fetch=originalFetch;}
});

test('native failures log request-correlated sanitized HTTP and transport diagnostics',async()=>{
  const savedFetch=globalThis.fetch, savedWarn=console.warn;
  const records:Array<{[key:string]:unknown}>=[];
  console.warn=((message:unknown,data?:unknown)=>{if(message==='[NativeTool] provider_attempt_failed')records.push(data as Record<string,unknown>);});
  const params={modelId:'gemini-pro-latest',system:'secret prompt',signal:new AbortController().signal,
    requestId:'test-request-42',turn:2,messages:[{role:'user',text:'private'}],tools:[]};
  try {
    globalThis.fetch=(async()=>new Response('sensitive upstream error',{status:429})) as typeof fetch;
    await assert.rejects(nativeToolTurn('google','secret-key',params as Parameters<typeof nativeToolTurn>[2]));
    assert.equal(records[0].requestId,'test-request-42');
    assert.equal(records[0].provider,'google');
    assert.equal(records[0].modelId,'gemini-pro-latest');
    assert.equal(records[0].status,429);
    assert.equal(records[0].classification,'rate_limited');
    globalThis.fetch=(async()=>{throw new TypeError('credentials and private details');}) as typeof fetch;
    await assert.rejects(nativeToolTurn('openai','secret-key',params as Parameters<typeof nativeToolTurn>[2]));
    assert.equal(records[1].status,null);
    assert.equal(records[1].classification,'transport_error');
    assert.ok(!JSON.stringify(records).includes('secret'));
    assert.ok(!JSON.stringify(records).includes('private'));
  } finally {globalThis.fetch=savedFetch;console.warn=savedWarn;}
});

test('OpenAI adapter preserves upstream HTTP 404 and does not log provider response body',async()=>{
  const {OpenAiProvider}=await import('../lib/providers/openai-provider');
  const savedFetch=globalThis.fetch,savedWarn=console.warn;
  const logs:string[]=[];
  globalThis.fetch=(async()=>new Response(JSON.stringify({error:{message:'sensitive upstream secret',type:'invalid_request_error',code:'model_not_found'}}),{status:404,headers:{'content-type':'application/json'}})) as typeof fetch;
  console.warn=(...args:unknown[])=>{logs.push(JSON.stringify(args));};
  try {
    const provider=new OpenAiProvider('test-key');
    await assert.rejects(provider.generate({modelId:'gpt-5-chat-latest',name:'Katie',persona:'test',summary:'',user:'ping',history:[]}),error=>{
      assert.equal((error as {status:number}).status,404);
      return true;
    });
    assert.ok(!logs.join('').includes('sensitive upstream secret'));
  }finally {globalThis.fetch=savedFetch;console.warn=savedWarn;}
});

test('native inference supports bounded response bodies above the old 256KB limit', async () => {
  const saved=globalThis.fetch;
  const oversizedText='a'.repeat(280_000);
  globalThis.fetch=(async()=>new Response(JSON.stringify({model:'gemini-test',candidates:[{content:{parts:[{text:oversizedText}]}}]}),{status:200})) as typeof fetch;
  try {
    const reply=await nativeToolTurn('google','test-key',{modelId:'gemini-test',system:'test',
      messages:[{role:'user',text:'hello'}],tools:[],signal:AbortSignal.timeout(5000)});
    assert.equal(reply.response.text.length,oversizedText.length);
  }finally{globalThis.fetch=saved;}
});

test('Claude tool requests cache only the explicit persona prefix', async () => {
  const originalFetch = globalThis.fetch;
  let body: any;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Done' }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 5 } }));
  };
  try {
    const system = 'Stable persona\nCURRENT_REQUEST_TIMESTAMP_UTC: now\nCurrent memory';
    const result = await nativeToolTurn('anthropic', 'test', { modelId: 'claude-sonnet-5-5', system, cacheablePersona: 'Stable persona', messages: [{ role: 'user', text: 'Hi' }], tools: [], signal: new AbortController().signal });
    assert.equal(body.system.map((block: any) => block.text).join(''), system);
    assert.equal(body.system[0].cache_control.ttl, '5m');
    assert.equal(body.system[1].cache_control, undefined);
    assert.equal(result.response.usage?.inputTokens, 1210);
    assert.equal(result.response.usage?.cacheReadInputTokens, 1000);
  } finally { globalThis.fetch = originalFetch; }
});
