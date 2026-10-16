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
 for(const [key,value] of Object.entries(overrides))if(key.startsWith('@/'))overrides[resolve(key.slice(2))]=value;
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
const {NextRequest}=native('next/server');
const cfg={name:'Analyst',instructions:'Use evidence and verify arithmetic.',research:false,attachments:false,development:false,reviewMode:'always',maxActiveTasks:2,maxInputChars:8000};
const team=Array.from({length:3},()=>({id:randomUUID(),actor_id:randomUUID(),config:{...cfg},version:1,archived:false}));team[1].config.research=true;
const mission=()=>({id:randomUUID(),objective:'Assess a service offer using supplied economics and market evidence.',team:structuredClone(team),status:'running',max_calls:12,calls:0,token_allowance:60000,reserved_tokens:0,actual_tokens:0,max_minutes:20,deadline:new Date(Date.now()+1200000).toISOString(),result:null,repository_id:null});
const job=(m,role='work',key='work')=>({id:randomUUID(),mission_id:m.id,job_key:key,role,agent_id:team[0].id,instruction:'Analyze supplied economics',dependencies:[],payload:{capability:'analysis'},status:'running',attempts:1,lease:randomUUID(),lease_until:new Date(Date.now()+360000).toISOString(),result:null});

const assessment={objective:'A supported recommendation',qualifications:['Service economics'],strongestEvidence:['Supplied assumptions'],criteria:['Supported recommendation'],synthesis:{conclusion:'Weigh economics and market evidence',dimensions:[{dimension:'Economics',supportedScope:'Scenario analysis',evidence:['Supplied assumptions']}],emphasis:'Decision relevance'},taskContract:{deliverable:'A recommendation',requirements:[{id:'outcome',requirement:'A supported recommendation',sourceId:'latest-user',status:'active'}],conflicts:[]}};
const verdict=(decision='approve')=>({verdict:decision,findings:decision==='approve'?'Verified complete outcome':'Incorrect arithmetic',checks:modules()('@/lib/collaboration/review-contract').acceptanceIds(assessment).map(id=>({id,passed:decision==='approve',evidence:decision==='approve'?'Specific support checked':'Incorrect arithmetic in the draft'}))});
test('planner rejects invented agents, unauthorized research/development, duplicate keys and dependency cycles',()=>{
 const {validatePlan}=modules()('@/lib/missions/types'),m=mission();
 const one={key:'economics',agentId:team[0].id,instruction:'Calculate economics',capability:'analysis',dependencies:[]};
 assert.equal(validatePlan({assignments:[one],deliverable:'Recommendation'},m).assignments.length,1);
 for(const a of [{...one,agentId:randomUUID()},{...one,capability:'research'},{...one,capability:'development'},{...one,key:'compose'},{...one,dependencies:['later']}])assert.throws(()=>validatePlan({assignments:[a],deliverable:'Recommendation'},m));
 assert.throws(()=>validatePlan({assignments:[one,one],deliverable:'Recommendation'},m));
});
test('calculation tool executes arithmetic and denies arbitrary code, zero division and nonfinite output',()=>{
 const {calculate}=modules()('@/lib/missions/types');assert.equal(calculate({operation:'multiply',values:[12,175]}).result,2100);
 for(const value of [{operation:'eval',values:[1,2]},{operation:'divide',values:[1,0]},{operation:'power',values:[1e100,100]},{operation:'add',values:[1,2],code:'process.env'}])assert.throws(()=>calculate(value));
});
test('actual coordinator persists bounded assignments, draft-blind review and a verified deliverable',async()=>{
 const m=mission(),jobs=[job(m,'plan','plan')],calls=[];
 const store={readMission:async()=>({mission:m,jobs:structuredClone(jobs)}),rpc:async(name,args)=>{
  assert.equal(name,'commit_mission_work');const j=jobs.find(j=>j.id===args.p_id);assert.equal(args.p_lease,j.lease);Object.assign(j,{status:args.p_status,result:args.p_result});
  for(const c of args.p_children)jobs.push({...job(m,c.role,c.key),agent_id:c.agent_id,instruction:c.instruction,dependencies:c.dependencies,payload:c.payload??{},status:'queued'});
  if(args.p_mission_status)m.status=args.p_mission_status;if(args.p_final)m.result=args.p_final;return true;
 }};
 const model=async(claim,instruction,input,tools)=>{calls.push({key:claim.job.job_key,instruction,input,tools});let text='Supported final recommendation';if(claim.job.role==='plan')text=JSON.stringify({assignments:[{key:'economics',agentId:team[0].id,instruction:'Calculate supplied economics',capability:'analysis',dependencies:[]},{key:'market',agentId:team[1].id,instruction:'Research comparable offers',capability:'research',dependencies:[]}],deliverable:'A supported recommendation'});if(claim.job.role==='review')text=instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?JSON.stringify(verdict()):JSON.stringify(assessment);return{text,sources:[],calculations:[],model:'fixture'};};
 const {executeClaim}=modules({'@/lib/missions/store':store})('@/lib/missions/worker');
 await executeClaim({mission:m,job:jobs[0]},model);assert.equal(jobs.length,5);
 for(const key of ['economics','market','compose','review']){const j=jobs.find(x=>x.job_key===key);j.status='running';await executeClaim({mission:m,job:j},model);}
 assert.equal(m.status,'completed');assert.equal(m.result,'Supported final recommendation');
 const review=calls.filter(x=>x.key==='review');assert.equal(review.length,2);assert.doesNotMatch(review[0].input,/Supported final recommendation/);assert.match(review[1].input,/Supported final recommendation/);
 assert.equal(calls.find(x=>x.key==='market').tools,'research');assert.equal(calls.find(x=>x.key==='economics').tools,'calculate');
});
test('a second unsuccessful review blocks instead of creating an endless repair loop',async()=>{
 const m=mission(),compose={...job(m,'compose','compose'),status:'completed',result:{text:'Incorrect draft'}},revision={...job(m,'revise','revision'),status:'completed',result:{text:'Still incorrect'}};
 const review=job(m,'review','review_again');let committed;
 const {executeClaim}=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[compose,revision,review]}),rpc:async(_,args)=>{committed=args;return true;}}})('@/lib/missions/worker');
 await executeClaim({mission:m,job:review},async(_,instruction)=>({text:instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?JSON.stringify(verdict('revise')):JSON.stringify(assessment),sources:[],calculations:[],model:'fixture'}));
 assert.equal(committed.p_mission_status,'blocked');assert.equal(committed.p_children.length,0);assert.equal(committed.p_final,null);
});
function modelFixture(responses,reserve=true){let dispatches=0;const ledger=[];
 class Client{responses={create:async request=>{dispatches++;ledger.push(request);return responses.shift();}};}
 const load=modules({'openai':{__esModule:true,default:Client},'@/lib/missions/store':{rpc:async(name,args)=>{if(name==='reserve_mission_call')return reserve;return true;}}});
 return{call:load('@/lib/missions/model').missionModel,ledger,count:()=>dispatches};
}
const response=(text,extra={})=>({status:'completed',output_text:text,output:[],usage:{total_tokens:12},...extra});
test('real model boundary does not dispatch without a reservation or research permission',async()=>{
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';try{const m=mission(),j=job(m),f=modelFixture([],false);await assert.rejects(f.call({mission:m,job:j},'instructions','input'),/allowance/);assert.equal(f.count(),0);const g=modelFixture([]);await assert.rejects(g.call({mission:m,job:j},'instructions','input','research'),/permission/);assert.equal(g.count(),0);}finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
});
test('real model tool loop executes only typed calculation and returns its exact result to the model',async()=>{
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';try{const m=mission(),j=job(m),f=modelFixture([response('',{output:[{type:'function_call',name:'calculate',call_id:'calculation',arguments:JSON.stringify({operation:'multiply',values:[12,175]})}]}),response('2100')]);const r=await f.call({mission:m,job:j},'Calculate','Economics','calculate');assert.equal(r.calculations[0].result,2100);assert.equal(f.count(),2);assert.match(JSON.stringify(f.ledger[1].input),/2100/);assert.equal(f.ledger[0].max_output_tokens,3000);assert.equal(f.ledger[1].tools,undefined);}finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
});
test('mission API rejects forged runtime fields and never runs background work inline',async()=>{
 let invoked=0;const load=modules({'@/lib/missions/store':{rpc:async()=>{invoked++;return mission();},readMission:async()=>({mission:mission(),jobs:[]})}}),route=load('@/app/api/missions/route');const id=randomUUID();const send=body=>route.POST(new NextRequest('http://local/api/missions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
 for(const b of [{action:'start',id,model:'unbounded'},{action:'create',id,objective:'x',agents:[team[0].id],minutes:20,maxCalls:999},{action:'approve',id,payload:{approved:true}}])assert.equal((await send(b)).status,409);
 assert.equal(invoked,0);assert.equal((await send({action:'start',id})).status,200);assert.equal(invoked,1);
});
