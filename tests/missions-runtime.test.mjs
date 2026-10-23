import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID, webcrypto, createHash } from 'node:crypto';
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
 assert.equal(jobs.find(x=>x.job_key==='review').result.detail,'Independent review approved the completed deliverable.');
 const review=calls.filter(x=>x.key==='review');assert.equal(review.length,2);assert.doesNotMatch(review[0].input,/Supported final recommendation/);assert.doesNotMatch(review[0].input,/A supported recommendation/,'Planner framing must not define independent criteria');assert.match(review[1].input,/Supported final recommendation/);
 assert.equal(calls.find(x=>x.key==='market').tools,'research');assert.equal(calls.find(x=>x.key==='economics').tools,'calculate');
 assert.doesNotMatch(calls.find(x=>x.key==='market').instruction,/KATIE_OBJECTIVE_FIRST_STANDARD/);assert.match(calls.find(x=>x.key==='market').instruction,/Complete only input.assignment/);assert.match(calls.find(x=>x.key==='compose').instruction,/KATIE_OBJECTIVE_FIRST_STANDARD/);assert.match(calls.find(x=>x.key==='compose').instruction,/ENTIRE response/);
});
test('revision and re-review retain findings, checks and source evidence without duplicating private blind criteria',async()=>{
 const m=mission(),evidence={...job(m,'work','evidence'),status:'completed',result:{text:'complete source evidence sentinel',sources:[{url:'https://example.com/source'}]}},compose={...job(m,'compose','compose'),status:'completed',result:{text:'Original candidate sentinel'}},review={...job(m,'review','review'),status:'completed',result:{verdict:'changes_requested',findings:['Shorten the full response'],checks:[{id:'length',passed:false,evidence:'The whole response exceeds the limit'+ 'CHECK_NOISE_SENTINEL'.repeat(2000)}],blindCriteria:'PRIVATE_CRITERIA_SENTINEL'.repeat(1000)}},revision=job(m,'revise','revision');const calls=[];
 const {executeClaim}=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[evidence,compose,review,revision]}),rpc:async()=>true}})('@/lib/missions/worker');
 await executeClaim({mission:m,job:revision},async(_,instruction,input)=>{calls.push({instruction,input});return{text:'Revised candidate',sources:[],calculations:[],model:'fixture'};});assert.match(calls[0].input,/complete source evidence sentinel/);assert.match(calls[0].input,/Original candidate sentinel/);assert.match(calls[0].input,/Shorten the full response/);assert.match(calls[0].input,/The whole response exceeds the limit/);assert.ok((calls[0].input.match(/CHECK_NOISE_SENTINEL/g)||[]).length<30);assert.ok(calls[0].input.length<48000);assert.doesNotMatch(calls[0].input,/PRIVATE_CRITERIA_SENTINEL/);assert.match(calls[0].instruction,/ENTIRE response/);
 revision.status='completed';revision.result={text:'Revised candidate'};const again=job(m,'review','review_again');await executeClaim({mission:m,job:again},async(_,instruction,input)=>{calls.push({instruction,input});return{text:instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?JSON.stringify(verdict()):JSON.stringify(assessment),sources:[],calculations:[],model:'fixture'};});assert.doesNotMatch(calls[1].input,/Original candidate sentinel|Revised candidate|PRIVATE_CRITERIA_SENTINEL/);assert.match(calls[2].input,/Revised candidate/);assert.match(calls[2].input,/Shorten the full response/);assert.doesNotMatch(calls[2].input,/PRIVATE_CRITERIA_SENTINEL/);
});
test('a second unsuccessful review blocks instead of creating an endless repair loop',async()=>{
 const m=mission(),compose={...job(m,'compose','compose'),status:'completed',result:{text:'Incorrect draft'}},revision={...job(m,'revise','revision'),status:'completed',result:{text:'Still incorrect'}};
 const review=job(m,'review','review_again');let committed;
 const {executeClaim}=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[compose,revision,review]}),rpc:async(_,args)=>{committed=args;return true;}}})('@/lib/missions/worker');
 await executeClaim({mission:m,job:review},async(_,instruction)=>({text:instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?JSON.stringify(verdict('revise')):JSON.stringify(assessment),sources:[],calculations:[],model:'fixture'}));
 assert.equal(committed.p_mission_status,'blocked');assert.equal(committed.p_children.length,0);assert.equal(committed.p_final,null);
});
function modelFixture(responses,reserve=true,inputCount=12){let dispatches=0;const ledger=[],counts=[],reservations=[];
 class Client{post=async(path,options)=>{counts.push({path,...options});if(inputCount instanceof Error)throw inputCount;return{input_tokens:inputCount};};responses={create:async request=>{dispatches++;ledger.push(request);return responses.shift();}};}
 const load=modules({'@/lib/orchestration/routing':{orchestrationChoices:async input=>[{provider:{name:'openai'},modelId:input.planning||input.research||input.review||/Analyze/.test(input.instruction)?'gpt-5.4':'gpt-5-mini',reasoning:'Injected transport fixture'}],orchestrationFailure:async()=>{}},'openai':{__esModule:true,default:Client},'@/lib/missions/store':{rpc:async(name,args)=>{if(name==='reserve_mission_call'){reservations.push(args);return reserve;}return true;}}});
 return{call:load('@/lib/missions/model').missionModel,ledger,counts,reservations,count:()=>dispatches};
}
const response=(text,extra={})=>({status:'completed',output_text:text,output:[],usage:{total_tokens:12},...extra});
test('budget uses counted input with output headroom and conservatively falls back when unavailable',async()=>{
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';try{const m=mission(),j=job(m),input='Long evidence '.repeat(2000),f=modelFixture([response('Analysis')],true,4000);await f.call({mission:m,job:j},'Analyze',input);assert.equal(f.reservations[0].p_tokens,4000+256+3000);assert.equal(f.counts[0].path,'/responses/input_tokens');assert.equal(f.counts[0].body.input[0].content,input);assert.equal(f.counts[0].body.max_output_tokens,undefined);assert.equal(f.counts[0].timeout,15000);const fallback=modelFixture([response('Analysis')],true,Error('Counting unavailable'));await fallback.call({mission:m,job:j},'Analyze',input);assert.ok(fallback.reservations[0].p_tokens>Buffer.byteLength(input)+3000);}finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
});
test('planner dispatch constrains assignment keys with the actual strict output schema',async()=>{
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';try{const m=mission(),j=job(m,'plan','plan'),f=modelFixture([response('{}')]);await f.call({mission:m,job:j},'Plan','Objective');const format=f.ledger[0].text.format;assert.equal(format.type,'json_schema');assert.equal(format.strict,true);const assignments=format.schema.properties.assignments;assert.equal(assignments.maxItems,3);assert.equal(assignments.items.additionalProperties,false);assert.equal(assignments.items.properties.key.pattern,'^[a-z][a-z0-9_]{0,24}$');assert.equal(assignments.items.properties.agentId.format,'uuid');assert.equal(assignments.items.properties.instruction.maxLength,5000);const other=modelFixture([response('Analysis')]);await other.call({mission:m,job:job(m)},'Analyze','Input');assert.equal(other.ledger[0].text,undefined);}finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
});
test('real model boundary does not dispatch without a reservation or research permission',async()=>{
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';try{const m=mission(),j=job(m),f=modelFixture([],false);await assert.rejects(f.call({mission:m,job:j},'instructions','input'),/allowance/);assert.equal(f.count(),0);const g=modelFixture([]);await assert.rejects(g.call({mission:m,job:j},'instructions','input','research'),/permission/);assert.equal(g.count(),0);}finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
});
test('real model tool loop executes only typed calculation and returns its exact result to the model',async()=>{
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';try{const m=mission(),j=job(m),f=modelFixture([response('',{output:[{type:'function_call',name:'calculate',call_id:'calculation',arguments:JSON.stringify({operation:'multiply',values:[12,175]})}]}),response('2100')]);const r=await f.call({mission:m,job:j},'Calculate','Economics','calculate');assert.equal(r.calculations[0].result,2100);assert.equal(f.count(),2);assert.match(JSON.stringify(f.ledger[1].input),/2100/);assert.equal(f.ledger[0].max_output_tokens,3000);assert.equal(f.ledger[1].tools[0].name,'calculate');assert.match(f.ledger[0].instructions,/independent calculations together/);assert.match(f.ledger[1].instructions,/COMPLETE assigned analysis/);assert.match(f.ledger[1].instructions,/Do not emit tool arguments/);}finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
});
test('mission API rejects forged runtime fields and never runs background work inline',async()=>{
 let invoked=0;const load=modules({'@/lib/missions/store':{rpc:async()=>{invoked++;return mission();},readMission:async()=>({mission:mission(),jobs:[]})}}),route=load('@/app/api/missions/route');const id=randomUUID();const send=body=>route.POST(new NextRequest('http://local/api/missions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
 for(const b of [{action:'start',id,model:'unbounded'},{action:'create',id,objective:'x',agents:[team[0].id],minutes:20,maxCalls:999},{action:'approve',id,payload:{approved:true}}])assert.equal((await send(b)).status,409);
 assert.equal(invoked,0);assert.equal((await send({action:'start',id})).status,200);assert.equal(invoked,1);
});
test('dependent arithmetic keeps its tool available within four model turns and eight total calculations',async()=>{
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';try{const m=mission(),j=job(m),tool=(id,operation,values)=>response('',{output:[{type:'function_call',name:'calculate',call_id:id,arguments:JSON.stringify({operation,values})}]}),f=modelFixture([tool('labor','multiply',[12,175]),tool('cost','add',[2100,150]),tool('profit','subtract',[3500,2250]),response('Contribution is $1,250 before overhead.')]);const result=await f.call({mission:m,job:j},'Analyze','Economics','calculate');assert.equal(f.count(),4);assert.equal(result.calculations[2].result,1250);assert.equal(f.ledger[1].tools[0].name,'calculate');assert.equal(f.ledger[2].tools[0].name,'calculate');assert.equal(f.ledger[3].tools,undefined);assert.match(f.ledger[3].instructions,/No tools remain/);const nine=Array.from({length:9},(_,i)=>({type:'function_call',name:'calculate',call_id:String(i),arguments:'{"operation":"add","values":[1,2]}'}));const excess=modelFixture([response('',{output:nine}),response('Eight valid calculations completed; ninth request rejected.')]);const clipped=await excess.call({mission:m,job:j},'Analyze','Economics','calculate');assert.equal(excess.count(),2);assert.equal(clipped.calculations.length,8);assert.equal(excess.ledger[1].input.filter(x=>x.type==='function_call_output').length,9);assert.match(excess.ledger[1].input.at(-1).output,/allowance exhausted/);assert.match(clipped.text,/ninth request rejected/);}finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
});
test('qualitative analysis can finish without fabricating a calculation',async()=>{
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';try{const m=mission(),j=job(m),f=modelFixture([response('The evidence favors a focused positioning strategy.')]);const result=await f.call({mission:m,job:j},'Compare qualitative positioning','No numerical assumptions are supplied.','calculate');assert.equal(result.calculations.length,0);assert.equal(f.count(),1);assert.equal(f.ledger[0].tool_choice,'auto');assert.match(result.text,/positioning strategy/);}finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
});
test('a section-specific word limit does not become a limit on the entire report',async()=>{
 for(const objective of ['Write a report with an executive summary of at most 3 words.','Write a report. The executive summary must be at most 3 words.','Write a report. At most 3 words for the executive summary.']){const m=mission();m.objective=objective;const compose={...job(m,'compose','compose'),status:'completed',result:{text:'Summary: Proceed.\n\nThe complete report contains additional supported detail.'}},review=job(m,'review','review');let committed;const {executeClaim}=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[compose,review]}),rpc:async(_,args)=>{committed=args;return true;}}})('@/lib/missions/worker');await executeClaim({mission:m,job:review},async(_,instruction)=>({text:instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?JSON.stringify(verdict()):JSON.stringify(assessment),sources:[],calculations:[],model:'fixture'}));assert.equal(committed.p_result.wordLimit,null);assert.equal(committed.p_result.verdict,'pass');assert.equal(committed.p_mission_status,'completed');}
});
test('a calculator continuation cannot masquerade as a completed analysis',async()=>{
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';try{for(const output of ['{"operation":"add","values":[2100,150]}','Next calculation.{"operation":"add","values":[2100,150]}','```json\n{"operation":"add","values":[2100,150]}\n```']){const m=mission(),j=job(m),f=modelFixture([response('',{output:[{type:'function_call',name:'calculate',call_id:'one',arguments:'{"operation":"multiply","values":[12,175]}'}]}),response(output)]);await assert.rejects(f.call({mission:m,job:j},'Analyze','Economics','calculate'),/tool arguments instead/);assert.equal(f.count(),2);assert.equal(f.ledger[0].tool_choice,'auto');assert.equal(f.ledger[0].model,'gpt-5.4');}}finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
});

test('an approving model cannot bypass an explicit whole-response word limit',async()=>{
 const m=mission();m.objective='Give a recommendation in no more than 3 words.';const compose={...job(m,'compose','compose'),status:'completed',result:{text:'This candidate is clearly too long'}},review=job(m,'review','review');let committed;
 const {executeClaim}=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[compose,review]}),rpc:async(_,args)=>{committed=args;return true;}}})('@/lib/missions/worker');await executeClaim({mission:m,job:review},async(_,instruction)=>({text:instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?JSON.stringify(verdict()):JSON.stringify(assessment),sources:[],calculations:[],model:'fixture'}));assert.equal(committed.p_result.verdict,'changes_requested');assert.equal(committed.p_result.wordCount,6);assert.equal(committed.p_result.wordLimit,3);assert.equal(committed.p_final,null);assert.equal(committed.p_children.length,2);assert.match(committed.p_result.summary,/entire deliverable contains 6/);
 review.job_key='review_again';const revision={...compose,job_key:'revision'};const load=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[revision,review]}),rpc:async(_,args)=>{committed=args;return true;}}});await load('@/lib/missions/worker').executeClaim({mission:m,job:review},async(_,instruction)=>({text:instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?JSON.stringify(verdict()):JSON.stringify(assessment),sources:[],calculations:[],model:'fixture'}));assert.equal(committed.p_mission_status,'blocked');assert.equal(committed.p_final,null);assert.equal(committed.p_children.length,0);
});

test('Executive coding approval delegates to Developer project without bypassing its contract or issuing another GitHub issue',async()=>{
 const m=mission();m.repository_id=randomUUID();m.objective='Build a playable browser game with deterministic rules';m.team[0].config.development=true;
 const j=job(m,'development','coding');j.payload={};
 const task={id:j.id,actor_id:randomUUID(),chat_id:randomUUID(),external:{issueUrl:'https://github.com/owner/repo/issues/650'}};
 const projects=[],commits=[];let status='running';
 const {executeClaim}=modules({
  '@/lib/projects/store':{projectRpc:async(name,args)=>{projects.push({name,args});return {id:args.p_id,status,result:status==='completed'?'VERIFIED DEVELOPER ACCEPTANCE':null};},getDevelopmentProjectContext:async()=>null,acceptanceBinding:()=>({})},
  '@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[j]}),rpc:async(name,args)=>{if(name==='mission_development_task')return task;if(name==='commit_mission_work'){commits.push(args);return true;}assert.fail('Unexpected RPC '+name);}},
 })('@/lib/missions/worker');
 const execute=()=>executeClaim({mission:m,job:j},()=>assert.fail('Delegation must not execute a coding model'));
 await execute();assert.equal(commits.at(-1).p_status,'awaiting_approval');assert.equal(projects.length,0);
 j.payload.approved=true;
 await execute();assert.equal(commits.at(-1).p_status,'waiting_external');assert.equal(projects.length,1);
 assert.equal(projects[0].name,'create_game_work_project');assert.equal(projects[0].args.p_request,'executive-delegated:'+m.id);
 assert.equal(projects[0].args.p_actor,task.actor_id);assert.equal(projects[0].args.p_chat,task.chat_id);assert.equal(projects[0].args.p_repository,m.repository_id);
 assert.equal(commits.at(-1).p_result.delegatedProjectId,projects[0].args.p_id);
 j.payload.approved=true;await execute();assert.equal(projects[1].args.p_id,projects[0].args.p_id);assert.equal(commits.at(-1).p_status,'waiting_external');
 status='completed';await execute();assert.equal(commits.at(-1).p_status,'completed');assert.equal(commits.at(-1).p_result.output,'VERIFIED DEVELOPER ACCEPTANCE');
});

test('an approval carrying essential missing input stays blocked and preserves the actual question',async()=>{
 const m=mission(),compose={...job(m,'compose','compose'),status:'completed',result:{text:'A plausible candidate'}},j=job(m,'review','review');let committed;
 const {executeClaim}=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[compose,j]}),rpc:async(_,args)=>{committed=args;return true;}}})('@/lib/missions/worker');
 const clarification={question:'What delivery cost should this analysis use?',missingFact:'Delivery cost',essential:true};
 await executeClaim({mission:m,job:j},async(_,instruction)=>({text:instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?JSON.stringify({...verdict(),clarification}):JSON.stringify(assessment),sources:[],calculations:[],model:'fixture'}));
 assert.equal(committed.p_mission_status,'blocked');assert.equal(committed.p_final,null);assert.equal(committed.p_children.length,0);
 assert.equal(committed.p_result.verdict,'blocked');assert.equal(committed.p_result.clarification.essential,true);assert.equal(committed.p_result.detail,clarification.question);
});
test('research requires native URL citations and uses a capable model without relaxing its budget',async()=>{
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';try{
  const m=mission(),j=job(m);j.agent_id=m.team[1].id;
  const cited=response('Primary provider finding',{output:[{type:'web_search_call'},{type:'message',content:[{type:'output_text',annotations:[{type:'url_citation',url:'https://provider.example/diagnostic',title:'Provider diagnostic'}]}]}]});
  const f=modelFixture([cited]);const result=await f.call({mission:m,job:j},'Research','Find comparable providers','research');assert.equal(f.ledger[0].model,'gpt-5.4');assert.equal(f.ledger[0].max_tool_calls,4);assert.equal(result.sources[0].url,'https://provider.example/diagnostic');assert.equal(f.reservations[0].p_tokens,12+256+3000+32000);
  const uncited=modelFixture([response('Remembered URL https://provider.example',{output:[{type:'web_search_call'},{type:'message'}]})]);await assert.rejects(uncited.call({mission:m,job:j},'Research','Find providers','research'),/no cited live sources/);
 }finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
});

test('research accepts explicit links only when independently present in native consulted-source metadata',async()=>{
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';try{
  const m=mission(),j=job(m);j.agent_id=m.team[1].id;const url='https://provider.example/diagnostic';
  const f=modelFixture([response('Offering [primary source]('+url+')',{output:[{type:'web_search_call',action:{type:'search',sources:[{type:'url',url}]}}]})]);
  const r=await f.call({mission:m,job:j},'Research','Find providers','research');assert.equal(r.sources[0].url,url);const bare=modelFixture([response('Provider page: '+url+'.',{output:[{type:'web_search_call',action:{type:'search',sources:[{type:'url',url}]}}]})]);const b=await bare.call({mission:m,job:j},'Research','Find providers','research');assert.equal(b.sources[0].url,url);assert.deepEqual(Array.from(f.ledger[0].include),['web_search_call.action.sources']);
  for(const text of ['Unsupported [source](https://invented.example/)','No citation in this answer']){
   const bad=modelFixture([response(text,{output:[{type:'web_search_call',action:{type:'search',sources:[{type:'url',url}]}}]})]);
   await assert.rejects(bad.call({mission:m,job:j},'Research','Find providers','research'),error=>{assert.match(error.message,/no cited live sources/);assert.equal(error.partial.text,text);assert.equal(error.partial.consultedSources[0],url);return true;});
  }
 }finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
});

test('project specification schedules direct composition and independent review without repository execution or another planner call',async()=>{const m={...mission(),project_kind:'specification',objective:'ORIGINAL OUTCOME: Build a two-stage token board. REVIEWED RESEARCH: persisted source evidence. Produce ONLY the project specification JSON.'},j=job(m,'plan','plan');let committed;const {executeClaim}=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[j]}),rpc:async(n,a)=>{assert.equal(n,'commit_mission_work');committed=a;return true;}}})('@/lib/missions/worker');await executeClaim({mission:m,job:j},()=>assert.fail('The specification already has reviewed research; no general planner is needed'));assert.equal(m.repository_id,null);assert.deepEqual(Array.from(committed.p_children,c=>c.key),['compose','review']);assert.equal(committed.p_children[0].role,'compose');assert.equal(committed.p_children[0].dependencies.length,0);assert.deepEqual(Array.from(committed.p_children[1].dependencies),['compose']);assert.match(committed.p_children[0].instruction,/every original requirement/);assert.equal(committed.p_mission_status,null);});

test('saved project phase governs resumed legacy composition and both independent review passes without losing the original goal',async()=>{const m={...mission(),project_kind:'specification',objective:'ORIGINAL OUTCOME: Build a two-stage token board. REVIEWED RESEARCH: immutable source sentinel. Produce ONLY project specification JSON.'},compose={...job(m,'compose','compose'),instruction:'A blocker report stating implementation cannot begin without a connected repository.'},calls=[];let saved=[compose],committed;const {executeClaim}=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:saved}),rpc:async(_,a)=>{committed=a;return true;}}})('@/lib/missions/worker');await executeClaim({mission:m,job:compose},async(_,instruction,input)=>{calls.push({instruction,input});return{text:'{"requirements":["two-stage token board"]}',sources:[],calculations:[],model:'fixture'};});assert.match(calls[0].instruction,/SERVER-ASSIGNED PROJECT PHASE: specification/);assert.match(calls[0].instruction,/Do not infer that the project lacks a repository/);assert.match(calls[0].input,/immutable source sentinel/);assert.equal(JSON.parse(calls[0].input).projectPhase,'specification');assert.match(committed.p_result.text,/two-stage token board/);compose.status='completed';compose.result=committed.p_result;const review=job(m,'review','review');saved=[compose,review];await executeClaim({mission:m,job:review},async(_,instruction,input)=>{calls.push({instruction,input});return{text:instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?JSON.stringify(verdict()):JSON.stringify(assessment),sources:[],calculations:[],model:'fixture'};});assert.equal(calls.length,3);for(const call of calls.slice(1)){assert.match(call.instruction,/SERVER-ASSIGNED PROJECT PHASE: specification/);assert.match(call.input,/two-stage token board/);}assert.doesNotMatch(calls[1].input,/candidate/);assert.equal(committed.p_result.verdict,'pass');assert.equal(committed.p_mission_status,'completed');});

test('final project assessment uses actual integrated evidence and retains rejection of incomplete whole-project outcomes',async()=>{const m={...mission(),project_kind:'assessment',objective:'ORIGINAL OUTCOME: Build a complete game with AI and human play. Independently assess the ENTIRE outcome.',project_evidence:{finalIntegratedEvidence:{head:'a'.repeat(40),changedFiles:[{path:'app/game/page.tsx',patch:'INTEGRATED_SOURCE_SENTINEL'}]},preview:{browserAcceptance:{passed:true,checks:[{name:'Move token',passed:true}]}}}},plan=job(m,'plan','plan');let saved=[plan],committed;const calls=[];const {executeClaim}=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:saved}),rpc:async(_,a)=>{committed=a;return true;}}})('@/lib/missions/worker');await executeClaim({mission:m,job:plan},()=>assert.fail('Verified implementation evidence does not need another generic planner'));assert.deepEqual(Array.from(committed.p_children,c=>c.key),['compose','review']);assert.match(committed.p_children[0].instruction,/ENTIRE original user outcome/);assert.match(committed.p_children[1].instruction,/absent same-head deployed-browser proof/);const compose={...job(m,'compose','compose'),instruction:committed.p_children[0].instruction};saved=[compose];await executeClaim({mission:m,job:compose},async(_,instruction,input)=>{calls.push({instruction,input});return{text:'AI opponent evidence is missing; project is incomplete.',sources:[],calculations:[],model:'fixture'};});assert.match(calls[0].instruction,/SERVER-ASSIGNED PROJECT PHASE: assessment/);assert.match(calls[0].instruction,/Do not invent execution or waive any missing requirement/);assert.match(calls[0].input,/INTEGRATED_SOURCE_SENTINEL/);assert.match(calls[0].input,/browserAcceptance/);compose.status='completed';compose.result=committed.p_result;const review=job(m,'review','review');saved=[compose,review];await executeClaim({mission:m,job:review},async(_,instruction,input)=>{calls.push({instruction,input});return{text:instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?JSON.stringify(verdict('revise')):JSON.stringify(assessment),sources:[],calculations:[],model:'fixture'};});for(const call of calls.slice(1))assert.match(call.instruction,/SERVER-ASSIGNED PROJECT PHASE: assessment/);assert.match(calls[2].input,/INTEGRATED_SOURCE_SENTINEL/);assert.equal(committed.p_result.verdict,'changes_requested');assert.equal(committed.p_mission_status,null);assert.equal(committed.p_final,null);});

test('malformed independent assessment gets one durable draft-blind retry and remains blocked after a second invalid contract',async()=>{for(const succeeds of [true,false]){const m=mission(),compose={...job(m,'compose','compose'),status:'completed',result:{text:'PRIVATE_DRAFT_SENTINEL'}},review=job(m,'review','review'),commits=[],seen=[];let claimed=false;const {runMissionBatch}=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[compose,review]}),rpc:async(n,a)=>{if(n==='claim_mission_work'){if(claimed)return null;claimed=true;return{mission:m,job:review};}assert.equal(n,'commit_mission_work');commits.push(a);return true;}}})('@/lib/missions/worker');const bad={...assessment,taskContract:{...assessment.taskContract,conflicts:[{sourceIds:['invented-source'],resolution:'Unsupported citation'}]}};const model=async(_,instruction,input)=>{seen.push({instruction,input});return{text:instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?JSON.stringify(verdict()):JSON.stringify(review.attempts===1||!succeeds?bad:assessment),sources:[],calculations:[],model:'fixture'};};await runMissionBatch(model);assert.equal(commits[0].p_status,'queued');assert.equal(commits[0].p_mission_status,null);assert.match(commits[0].p_result.reviewContractFeedback,/Invalid task conflict provenance/);assert.equal(seen.length,1);assert.doesNotMatch(seen[0].input,/PRIVATE_DRAFT_SENTINEL/);review.attempts=2;review.result=commits[0].p_result;claimed=false;await runMissionBatch(model);assert.match(seen[1].input,/CONTRACT_VALIDATOR_FEEDBACK/);assert.match(seen[1].input,/latest-user/);assert.doesNotMatch(seen[1].input,/PRIVATE_DRAFT_SENTINEL/);assert.equal(commits[1].p_mission_status,succeeds?'completed':'blocked');assert.equal(commits[1].p_status,succeeds?'completed':'failed');if(succeeds){assert.equal(seen.length,3);assert.match(seen[2].input,/PRIVATE_DRAFT_SENTINEL/);}else assert.equal(seen.length,2);}});

test('game specification can express arbitrary exact states without sending an unsupported open JSON schema',async()=>{
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';
 try{
  const m={...mission(),project_kind:'specification',project_evidence:{projectProfile:'game'}},j=job(m,'compose','compose');
  const f=modelFixture([response('{"game":{"state":{"arbitrary":1}}}')]);await f.call({mission:m,job:j},'Produce JSON for the complete game specification','Saved game requirements');
  assert.equal(f.ledger[0].text.format.type,'json_object');assert.equal(f.ledger[0].max_output_tokens,16000);
  const normal=modelFixture([response('{}')]);await normal.call({mission:{...m,project_evidence:null},job:j},'Produce JSON','Ordinary software specification');
  assert.equal(normal.ledger[0].text.format.type,'json_schema');assert.equal(normal.ledger[0].text.format.schema.properties.game,undefined);
 }finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
});

test('measured whole-candidate length reaches review before judgment, including the research objective',async()=>{
 for(const limit of [3,700]){const m=mission();m.objective=`Original build context. Give concise source-supported findings in at most ${limit} words. Do not implement.`;
 const compose={...job(m,'compose','compose'),status:'completed',result:{text:'Six complete words constitute this candidate'}},review=job(m,'review','review');let committed;const inputs=[];
 const {executeClaim}=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[compose,review]}),rpc:async(_,args)=>{committed=args;return true;}}})('@/lib/missions/worker');
 await executeClaim({mission:m,job:review},async(_,instruction,input)=>{inputs.push(input);if(instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')){const evidence=JSON.parse(input.split('Evidence and candidate:\n')[1]);assert.equal(evidence.measuredLength.wordCount,6);assert.equal(evidence.measuredLength.wordLimit,limit);assert.match(instruction,/never estimate a conflicting count/);return{text:JSON.stringify(verdict()),sources:[],calculations:[],model:'fixture'};}return{text:JSON.stringify(assessment),sources:[],calculations:[],model:'fixture'};});
 assert.doesNotMatch(inputs[0],/Six complete words/);assert.equal(committed.p_result.wordLimit,limit);assert.equal(committed.p_result.verdict,limit===3?'changes_requested':'pass');
 }
});

test('research recovery sends substantive findings without duplicate historical assessments',async()=>{
 const m=mission();m.project_kind='research';m.project_evidence={researchRecovery:{sourceMissionId:'saved-source-mission',lastCandidate:{text:'OLD_CANDIDATE_SENTINEL'},independentFindings:{verdict:'changes_requested',findings:['Remove peripheral API detail'],blindCriteria:'HISTORICAL_ASSESSMENT_SENTINEL'.repeat(1200),summary:'DUPLICATE_SUMMARY',checks:[{id:'retained-rule',passed:true,evidence:'DUPLICATE_PASSED_CHECK'.repeat(900)},{id:'economy',passed:false,evidence:'Peripheral API details impair the requested concise brief'}]}}};
 const before=JSON.stringify(m.project_evidence),compose={...job(m,'compose','compose'),status:'completed',result:{text:'NEW_CANDIDATE_SENTINEL'}},review=job(m,'review','review'),work={...job(m,'work','source'),status:'completed',result:{text:'PRIMARY_SOURCE_EVIDENCE'}};let committed;
 const {executeClaim}=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[work,compose,review]}),rpc:async(_,args)=>{committed=args;return true;}}})('@/lib/missions/worker');
 await executeClaim({mission:m,job:review},async(_,instruction,input)=>{assert.ok(input.length<48000);if(instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')){assert.match(input,/PRIMARY_SOURCE_EVIDENCE/);assert.match(input,/NEW_CANDIDATE_SENTINEL/);assert.match(input,/Remove peripheral API detail/);assert.match(input,/Peripheral API details impair/);assert.doesNotMatch(input,/OLD_CANDIDATE_SENTINEL|HISTORICAL_ASSESSMENT_SENTINEL|DUPLICATE_PASSED_CHECK|DUPLICATE_SUMMARY/);}return{text:JSON.stringify(instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?verdict():assessment),sources:[],calculations:[],model:'fixture'};});
 assert.equal(committed.p_result.verdict,'pass');assert.equal(JSON.stringify(m.project_evidence),before,'Complete audit evidence remains unchanged');
 const {researchRecoveryEvidence}=modules()('@/lib/missions/research-evidence');assert.match(JSON.stringify(researchRecoveryEvidence(m.project_evidence,true)),/OLD_CANDIDATE_SENTINEL/);
});

test('game specification records provider truncation and retries only its first output-limit failure',async()=>{
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';try{const m=mission();m.project_kind='specification';m.project_evidence={projectProfile:'game'};const j=job(m,'compose','compose'),f=modelFixture([response('',{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}})]);await assert.rejects(f.call({mission:m,job:j},'Compose','Source'),e=>e.partial?.incompleteReason==='max_output_tokens'&&e.partial.outputTokenLimit===16000);assert.match(f.ledger[0].instructions,/minified complete JSON/);assert.match(f.ledger[0].instructions,/20,000 characters/);assert.match(f.ledger[0].instructions,/setup, action, turn, phase/);assert.match(f.ledger[0].instructions,/including engine architecture/);
 for(const [kind,profile,reason,attempts,retry] of [['specification','game','max_output_tokens',1,true],['specification','game','max_output_tokens',2,false],['specification','software','max_output_tokens',1,false],['development','game','max_output_tokens',1,false],['specification','game','content_filter',1,false],['specification','game',null,1,false]]){
  m.project_kind=kind;m.project_evidence={projectProfile:profile};j.attempts=attempts;let claimed=false,committed;const load=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[j]}),rpc:async(n,a)=>{if(n==='claim_mission_work'){if(claimed)return null;claimed=true;return{mission:m,job:j};}committed=a;return true;}}});const {MissionModelFailure}=load('@/lib/missions/model');await load('@/lib/missions/worker').runMissionBatch(async()=>{throw new MissionModelFailure('Model output incomplete: incomplete',{incompleteReason:reason,outputTokenLimit:16000});});assert.equal(committed.p_status,retry?'queued':'failed');assert.equal(committed.p_mission_status,retry?null:'blocked');assert.equal(committed.p_result.incompleteReason,reason);
 }
 }finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
});

test('failed Responses retain provider errors and transient codes retry once without treating invalid prompts as transient',async()=>{
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';try{
 for(const code of ['server_error','rate_limit_exceeded','invalid_prompt']){const m=mission(),j=job(m),f=modelFixture([response('',{status:'failed',error:{code,message:'Provider diagnostic'}})]);await assert.rejects(f.call({mission:m,job:j},'Analyze','Source'),e=>e.partial?.providerErrorCode===code&&e.partial.providerErrorMessage==='Provider diagnostic');
 let claimed=false,committed;const load=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[j]}),rpc:async(n,a)=>{if(n==='claim_mission_work'){if(claimed)return null;claimed=true;return{mission:m,job:j};}committed=a;return true;}}});const {MissionModelFailure}=load('@/lib/missions/model');await load('@/lib/missions/worker').runMissionBatch(async()=>{throw new MissionModelFailure('Model output incomplete: failed',{providerErrorCode:code,providerErrorMessage:'Provider diagnostic'});});assert.equal(committed.p_status,code==='invalid_prompt'?'failed':'queued');assert.equal(committed.p_result.providerErrorCode,code);
 }
 }finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
});
test('oversized game specification is rejected before review and repairs once against validation feedback',async()=>{
 const {gameFixture}=await import('./fixtures/game-project.mjs');const f=gameFixture(),valid={name:'Counter',summary:'A controlled counter',requirements:['Increment and reject invalid actions'],allowedPaths:f.allowedPaths,milestones:[{title:'Complete game',instruction:'Build every approved rule',contract:f.contract}],finalContract:f.contract,game:f.game};
 const m=mission();m.project_kind='specification';m.project_evidence={projectProfile:'game'};const j=job(m,'compose','compose');let claimed=false,committed,seen;
 const load=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[j]}),rpc:async(n,a)=>{if(n==='claim_mission_work'){if(claimed)return null;claimed=true;return{mission:m,job:j};}committed=a;return true;}}});const worker=load('@/lib/missions/worker');
 const oversized={...valid,requirements:Array(30).fill('x'.repeat(500)),summary:'x'.repeat(1800),milestones:Array.from({length:6},(_,i)=>({...valid.milestones[0],title:'Work package '+i,instruction:'x'.repeat(3500)}))};for(const invalid of [oversized,{...valid,game:undefined}]){claimed=false;await worker.runMissionBatch(async()=>({text:JSON.stringify(invalid),sources:[],calculations:[],model:'fixture'}));assert.equal(committed.p_status,'queued');assert.equal(committed.p_mission_status,null);assert.match(committed.p_result.specificationValidationFeedback,/bounded approval|Game specification requires/);assert.equal(committed.p_final,null);}
 j.attempts=2;j.result=committed.p_result;claimed=false;await worker.runMissionBatch(async(_,instruction,input)=>{seen=input;return{text:JSON.stringify(valid,null,2),sources:[],calculations:[],model:'fixture'};});assert.match(seen,/specificationValidationFeedback/);assert.equal(committed.p_status,'completed',JSON.stringify(committed.p_result));assert.equal(committed.p_result.text,JSON.stringify(valid));assert.equal(committed.p_mission_status,null,'Validation is not independent approval');
});

test('game review sees a lossless shared-contract view and completion retains the full original specification',async()=>{
 const {gameFixture}=await import('./fixtures/game-project.mjs');const f=gameFixture();const full={name:'Counter',summary:'Complete game',requirements:['Increment with no invalid-state mutation'],allowedPaths:f.allowedPaths,milestones:[{title:'Complete',instruction:'Implement all requirements',contract:f.contract}],finalContract:f.contract,game:f.game};const text=JSON.stringify(full);
 const m=mission();m.project_kind='specification';m.project_evidence={projectProfile:'game'};const compose={...job(m,'compose','compose'),status:'completed',result:{text}},review=job(m,'review','review');let committed;
 const {executeClaim}=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[compose,review]}),rpc:async(_,a)=>{committed=a;return true;}}})('@/lib/missions/worker');await executeClaim({mission:m,job:review},async(_,instruction,input)=>{if(instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')){const evidence=JSON.parse(input.split('Evidence and candidate:\n')[1]),candidate=evidence.candidate.result;assert.match(instruction,/GAME REVIEW REFERENCE SEMANTICS/);assert.equal(candidate.text,undefined);assert.equal(candidate.specification.milestones[0].contractRef,'finalContract');assert.equal(candidate.specification.game.acceptance.scenarios.find(s=>s.kind==='browser').stepsRef,'finalContract.scenarios[name=browser].steps');assert.deepEqual(candidate.specification.finalContract,full.finalContract);assert.deepEqual(candidate.specification.game.rules,full.game.rules);assert.deepEqual(candidate.specification.game.acceptance.scenarios.find(s=>s.kind==='model'),full.game.acceptance.scenarios.find(s=>s.kind==='model'));assert.match(candidate.fullSpecificationHash,/^[a-f0-9]{64}$/);assert.match(candidate.referenceNote,/Every original rule/);}return{text:JSON.stringify(instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?verdict():assessment),sources:[],calculations:[],model:'fixture'};});assert.equal(committed.p_final,text);assert.equal(compose.result.text,text);assert.equal(committed.p_result.verdict,'pass');
});

test('game second-pass review keeps findings but omits duplicated large prior-check matrices',async()=>{
 const {gameFixture}=await import('./fixtures/game-project.mjs');const f=gameFixture();
 const full={name:'Counter',summary:'Game',requirements:['Preserve original rules'],allowedPaths:f.allowedPaths,milestones:[{title:'Complete',instruction:'All rules',contract:f.contract}],finalContract:f.contract,game:f.game};
 const m={...mission(),project_kind:'specification',project_evidence:{projectProfile:'game'},objective:'Review saved game with original requirements.'};
 const compose={...job(m,'compose','compose'),status:'completed',result:{text:JSON.stringify(full)}};
 const checks=Array.from({length:250},(_,i)=>({id:'req-'+i,passed:false,evidence:'Previous details '+String(i).repeat(250)}));
 const previous={...job(m,'review','review'),status:'completed',result:{verdict:'changes_requested',findings:['Preserve the full browser scenarios'],checks}};
 const revision={...job(m,'revise','revision'),status:'completed',result:{text:JSON.stringify(full)}};
 const again=job(m,'review','review_again');let committed;
 const {executeClaim}=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[compose,previous,revision,again]}),rpc:async(_,a)=>{committed=a;return true;}}})('@/lib/missions/worker');
 await executeClaim({mission:m,job:again},async(_,instruction,input)=>{
  if(instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')){
   assert.ok(input.length<48000,'Repeated checks must not exhaust the independent review context');
   const evidence=JSON.parse(input.split('Evidence and candidate:\n')[1]);
   assert.equal(evidence.priorFindings[0].priorCheckCount,checks.length);
   assert.equal(evidence.priorFindings[0].checks,undefined);
   assert.deepEqual(Array.from(evidence.priorFindings[0].findings),['Preserve the full browser scenarios']);
   assert.deepEqual(evidence.candidate.result.specification.finalContract,full.finalContract);
  }
  return{text:JSON.stringify(instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?verdict():assessment),sources:[],calculations:[],model:'fixture'};
 });
 assert.equal(committed.p_mission_status,'completed');
 assert.equal(committed.p_result.verdict,'pass');
});

test('validation repair receives the rejected draft and stops after the third attempt',async()=>{
 const {gameFixture}=await import('./fixtures/game-project.mjs');const f=gameFixture();
 const draft={name:'Counter',summary:'Saved draft sentinel',requirements:['Increment and reject invalid actions'],allowedPaths:f.allowedPaths,milestones:[{title:'Complete game',instruction:'Build every approved rule',contract:f.contract}],finalContract:f.contract,game:f.game};
 const m={...mission(),project_kind:'specification',project_evidence:{projectProfile:'game'}};
 draft.game.rules.rules[0].category='invalid-category';
 const j={...job(m,'compose','compose'),attempts:2,result:{specificationValidationFeedback:'Invalid scenario count',rejectedSpecification:JSON.stringify(draft)}};let claimed=false,committed;
 const worker=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[j]}),rpc:async(n,a)=>{if(n==='claim_mission_work'){if(claimed)return null;claimed=true;return{mission:m,job:j};}committed=a;return true;}}})('@/lib/missions/worker');
 const invalid=async(_,instruction,input)=>{const data=JSON.parse(input);assert.equal(data.rejectedDraft.specification.summary,'Saved draft sentinel');assert.match(data.rejectedDraft.instruction,/100 total browser steps/);assert.equal(data.rejectedDraft.specification.milestones[0].contractRef,'finalContract');return{text:'{}',sources:[],calculations:[],model:'fixture'};};
 await worker.runMissionBatch(invalid);assert.equal(committed.p_status,'queued');
 j.attempts=3;claimed=false;await worker.runMissionBatch(invalid);assert.equal(committed.p_status,'failed');assert.equal(committed.p_mission_status,'blocked');
});

test('oversized rejected drafts cannot overflow the repair model input or disappear from storage',async()=>{
 const {gameFixture}=await import('./fixtures/game-project.mjs');const f=gameFixture();f.game.rules.stateModel.initialState.large='x'.repeat(60000);
 const draft={name:'Counter',summary:'Oversized draft',requirements:['Retain original requirement'],allowedPaths:f.allowedPaths,milestones:[{title:'Complete game',instruction:'Build every rule',contract:f.contract}],finalContract:f.contract,game:f.game};
 const text=JSON.stringify(draft),m={...mission(),objective:'Authoritative original requirement sentinel',project_kind:'specification',project_evidence:{projectProfile:'game'}},j={...job(m,'compose','compose'),result:{specificationValidationFeedback:'Specification exceeds bounded package',rejectedSpecification:text}};
 const worker=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[j]}),rpc:async()=>true}})('@/lib/missions/worker');
 await assert.rejects(worker.executeClaim({mission:m,job:j},async(_,instruction,input)=>{assert.ok(input.length<48000);const data=JSON.parse(input);assert.equal(data.objective,m.objective);assert.equal(data.rejectedDraft.specificationOmitted,true);assert.equal(data.rejectedDraft.specification,undefined);assert.ok(data.rejectedDraft.uniqueCharacters>48000);assert.ok(data.rejectedDraft.assessmentCapacity.requiredCharacters>data.rejectedDraft.assessmentCapacity.maximumCharacters);assert.ok(data.rejectedDraft.currentValidation.length<=600);throw Error('fixture stop after inspecting bounded input');}),/fixture stop/);
 assert.equal(j.result.rejectedSpecification,text);
});


test('unfittable original repair context blocks honestly and preserves the rejected draft',async()=>{
 const {gameFixture}=await import('./fixtures/game-project.mjs');const f=gameFixture();
 const draft={name:'Counter',summary:'Saved draft',requirements:['Retain every requirement'],allowedPaths:f.allowedPaths,milestones:[{title:'Complete',instruction:'Build all rules',contract:f.contract}],finalContract:f.contract,game:f.game};
 draft.game.rules.rules[0].category='invalid-category';
 const text=JSON.stringify(draft),m={...mission(),objective:'x'.repeat(48000),project_kind:'specification',project_evidence:{projectProfile:'game'}},j={...job(m,'compose','compose'),attempts:2,result:{specificationValidationFeedback:'Invalid scenario count',rejectedSpecification:text}};let claimed=false,committed;
 const worker=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[j]}),rpc:async(n,a)=>{if(n==='claim_mission_work'){if(claimed)return null;claimed=true;return{mission:m,job:j};}committed=a;return true;}}})('@/lib/missions/worker');
 await worker.runMissionBatch(()=>assert.fail('No unbounded model input may be sent'));
 assert.equal(committed.p_status,'failed');assert.equal(committed.p_result.repairContextOverflow,true);assert.equal(committed.p_result.rejectedSpecification,text);assert.equal(committed.p_result.specificationValidationFeedback,j.result.specificationValidationFeedback);
});


test('a saved specification made valid by a platform fix is reused without inference and still needs review',async()=>{
 const {gameFixture}=await import('./fixtures/game-project.mjs');const f=gameFixture(),draft={name:'Counter',summary:'Saved full draft',requirements:['All original requirements'],allowedPaths:f.allowedPaths,milestones:[{title:'Complete',instruction:'Build all rules',contract:f.contract}],finalContract:f.contract,game:f.game};
 const m={...mission(),project_kind:'specification',project_evidence:{projectProfile:'game'}},j={...job(m,'compose','compose'),result:{specificationValidationFeedback:'Old capacity estimate',rejectedSpecification:JSON.stringify(draft)}};let committed;
 const worker=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[j]}),rpc:async(_,a)=>{committed=a;return true;}}})('@/lib/missions/worker');
 await worker.executeClaim({mission:m,job:j},()=>assert.fail('Do not regenerate a valid saved draft'));
 assert.equal(committed.p_result.text,JSON.stringify(draft));assert.equal(committed.p_result.recovery.kind,'revalidated_saved_specification');assert.equal(committed.p_mission_status,null);assert.equal(committed.p_final,null);
});

test('read-only legacy repository jobs inspect evidence without dispatching a coding task or requesting approval',async()=>{
 const m=mission();m.repository_id='saved-repo';m.objective='Audit the connected repository read-only; do not modify code.';
 const j=job(m,'development','source_audit');let committed;let dispatched=0;const calls=[];
 const inspection={kind:'read_only_repository_inspection',sha:'a'.repeat(40),files:[{path:'core.ts',excerpt:'1: export const value=42;',throughLine:1}],checks:[]};
 const load=modules({
  '@/lib/missions/inspection':{readOnlyRepositoryObjective:()=>true,workflowInspection:async()=>null,repositoryInspection:async(_,__,choose)=>{assert.equal(await choose('manifest'),'paths');return inspection;}},
  '@/lib/agents/development':{dispatchDevelopment:async()=>{dispatched++;throw Error('No writes permitted');}},
  '@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[j]}),rpc:async(_,args)=>{committed=args;return true;}}
 });
 await load('@/lib/missions/worker').executeClaim({mission:m,job:j},async(_,instruction,input)=>{calls.push({instruction,input});return{text:input==='manifest'?'paths':'Source-grounded finding',sources:[],calculations:[],model:'routed'};});
 assert.equal(dispatched,0);assert.equal(committed.p_status,'completed');assert.equal(committed.p_result.inspection.sha,inspection.sha);assert.match(calls[1].input,/1: export const value=42/);assert.match(calls[1].instruction,/Never claim commands/);
});
test('task-selected models receive their own supported default reasoning configuration',async()=>{
 const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';try{
  const m=mission(),f=modelFixture([response('Analysis')]);await f.call({mission:m,job:job(m)},'Analyze','Evidence');
  assert.equal(f.ledger[0].reasoning,undefined);
 }finally{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});

test('repository inspection planning reserves room for a substantive revision and both reviews',()=>{
 const m=mission();m.repository_id='saved-repo';const {validatePlan}=modules()('@/lib/missions/types');
 const task=i=>({key:'source_'+i,agentId:m.team[0].id,instruction:'Inspect source',capability:'repository_review',dependencies:[]});
 assert.throws(()=>validatePlan({assignments:[task(1),task(2),task(3)],deliverable:'Audit'},m),/At most two/);
 assert.equal(validatePlan({assignments:[task(1),task(2),{...task(3),capability:'analysis'}],deliverable:'Audit'},m).assignments.length,3);
});
test('two source inspections plus analysis complete revision and both independent reviews within twelve model calls',async()=>{
 const m=mission();m.repository_id='saved-repo';const jobs=[job(m,'plan','plan')];let used=0;
 const store={readMission:async()=>({mission:m,jobs:structuredClone(jobs)}),rpc:async(name,args)=>{
  assert.equal(name,'commit_mission_work');const j=jobs.find(x=>x.id===args.p_id);Object.assign(j,{status:args.p_status,result:args.p_result});
  for(const child of args.p_children)jobs.push({...job(m,child.role,child.key),agent_id:child.agent_id,instruction:child.instruction,dependencies:child.dependencies,payload:child.payload??{},status:'queued'});
  if(args.p_mission_status)m.status=args.p_mission_status;if(args.p_final)m.result=args.p_final;return true;
 }};
 const model=async(c,instruction,input)=>{
  used++;assert.ok(used<=m.max_calls,'The supported revision cycle exceeded the saved call ceiling');let text='Supported findings';
  if(c.job.role==='plan')text=JSON.stringify({assignments:[{key:'source_one',agentId:team[0].id,instruction:'Inspect backend',capability:'repository_review',dependencies:[]},{key:'source_two',agentId:team[1].id,instruction:'Inspect frontend',capability:'repository_review',dependencies:[]},{key:'analysis',agentId:team[2].id,instruction:'Assess supplied evidence',capability:'analysis',dependencies:[]}],deliverable:'A supported recommendation'});
  if(c.job.role==='review')text=instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?JSON.stringify(verdict(c.job.job_key==='review'?'revise':'approve')):JSON.stringify(assessment);
  return{text,sources:[],calculations:[],model:'task-selected'};
 };
 const {executeClaim}=modules({'@/lib/missions/store':store,'@/lib/missions/inspection':{workflowInspection:async()=>null,readOnlyRepositoryObjective:()=>false,repositoryInspection:async(_,__,choose)=>{await choose('manifest');return{sha:'a'.repeat(40),files:[{path:'core.ts',excerpt:'1: inspected source'}]};}}})('@/lib/missions/worker');
 for(const key of ['plan','source_one','source_two','analysis','compose','review','revision','review_again']){const j=jobs.find(x=>x.job_key===key);assert.ok(j,key);j.status='running';await executeClaim({mission:m,job:j},model);}
 assert.equal(used,12);assert.equal(m.status,'completed');assert.equal(jobs.find(x=>x.job_key==='review_again').result.verdict,'pass');
});

test('long source reports are partitioned losslessly and rechecked independently without overflowing any model input',async()=>{
 const source=modules()('@/lib/executive/source-handoff'),marker=source.EXECUTIVE_SOURCE_MARKER;
 const reports=[0,1].map(i=>({missionId:'upstream-'+i,objective:'Reviewed source '+i,report:('Verified source '+i+' evidence. ').repeat(850)+' END_'+i,reviewJobId:'source-review-'+i,reviewVerdict:'pass',observedUpdatedAt:'2026-10-21'}));
 const groups=source.executiveSourceGroups(reports);assert.equal(groups.length,3);
 const m=mission();m.objective='Synthesize every source report with all material evidence.'+marker;const jobs=[job(m,'plan','plan')];let calls=0,sourceChecks=0;
 const store={readMission:async()=>({mission:m,jobs:structuredClone(jobs)}),rpc:async(name,args)=>{
  assert.equal(name,'commit_mission_work');const j=jobs.find(x=>x.id===args.p_id);Object.assign(j,{status:args.p_status,result:args.p_result});
  for(const child of args.p_children)jobs.push({...job(m,child.role,child.key),agent_id:child.agent_id,instruction:child.instruction,dependencies:child.dependencies,payload:child.payload??{},status:'queued'});
  if(args.p_mission_status)m.status=args.p_mission_status;if(args.p_final)m.result=args.p_final;return true;
 }};
 const model=async(c,instruction,input)=>{calls++;assert.ok(input.length<=48000,'Source handoff overflowed a model input');let text='Evidence-cited digest and final report';
  if(instruction.includes('EVERY original source fragment')){sourceChecks++;text=JSON.stringify({verdict:c.job.job_key==='review'?'changes_requested':'pass',findings:c.job.job_key==='review'?['Material source conflict must be resolved']:[],summary:'Full source group checked independently'});}
  else if(c.job.role==='review')text=instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?JSON.stringify(verdict('approve')):JSON.stringify(assessment);
  if(c.job.role==='revise')text='Revised evidence-cited synthesis';
  return{text,sources:[],calculations:[],model:'task-selected',provider:'native-provider'};
 };
 const {executeClaim}=modules({'@/lib/missions/store':store,'@/lib/executive/source-handoff':{...source,sourceReportsForMission:async()=>reports}})('@/lib/missions/worker');
 await executeClaim({mission:m,job:jobs[0]},model);assert.equal(calls,0,'Mechanical source partitioning should not spend inference');
 for(const key of [...groups.map((_,i)=>'source_'+i),'compose']){const j=jobs.find(x=>x.job_key===key);j.status='running';await executeClaim({mission:m,job:j},model);}
 for(const key of ['review','revision','review_again']){const j=jobs.find(x=>x.job_key===key);assert.ok(j,key);
  do{j.status='running';await executeClaim({mission:m,job:j},model);}while(j.status==='waiting_external');
 }
 assert.equal(m.status,'completed');assert.equal(sourceChecks,groups.length*2);assert.equal(calls,15);assert.ok(calls<=20);
 assert.equal(jobs.find(j=>j.job_key==='review_again').result.sourceChecks.checks.length,groups.length);
 assert.equal(jobs.find(j=>j.job_key==='review').result.verdict,'changes_requested','An approving overall model must not waive a failed full-source check');
 assert.notEqual(jobs.find(j=>j.job_key==='review').result.sourceChecks.key,jobs.find(j=>j.job_key==='review_again').result.sourceChecks.key);
});

test('completed source checks survive a later review transport failure without being paid for again',async()=>{
 const source=modules()('@/lib/executive/source-handoff'),m=mission();m.objective='Synthesize upstream source reports.'+source.EXECUTIVE_SOURCE_MARKER;
 const reports=[{missionId:'source',objective:'Audit',report:'Complete verified source report.',reviewJobId:'review-source',reviewVerdict:'pass',observedUpdatedAt:'2026-10-21'}],groups=source.executiveSourceGroups(reports);
 const candidate={...job(m,'compose','compose'),status:'completed',result:{text:'Candidate report'}},review=job(m,'review','review');
 review.result={sourceChecks:{key:createHash('sha256').update(JSON.stringify({candidate:'Candidate report',sourceGroups:groups})).digest('hex'),checks:[{verdict:'pass',findings:[],summary:'Previously verified full source'}]}};
 let claimed=false,committed,calls=0;
 const load=modules({'@/lib/executive/source-handoff':{...source,sourceReportsForMission:async()=>reports},'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[candidate,review]}),rpc:async(name,args)=>{if(name==='claim_mission_work'){if(claimed)return null;claimed=true;return{mission:m,job:review};}committed=args;return true;}}},{Error});
 await load('@/lib/missions/worker').runMissionBatch(async()=>{calls++;throw Error('500 provider unavailable');});
 assert.equal(calls,1,'A saved source check must not be rerun before the remaining review stage');assert.equal(committed.p_status,'queued');assert.deepEqual(committed.p_result.sourceChecks,review.result.sourceChecks);
});

test('audit review keeps the full immutable source and all acceptance gates inside the bounded envelope',async()=>{
 const m=mission();m.objective='Audit source evidence read-only. Preserve immutable source references and report actual coverage.';
 const excerpt='SOURCE_START\n'+ 'source line\n'.repeat(2600)+'SOURCE_END';
 const worker={...job(m,'work','source_audit'),status:'completed',result:{text:'Source finding',inspection:{sha:'a'.repeat(40),files:[{path:'core.ts',excerpt}]},routingReason:'transport diagnostic '.repeat(1000),attemptedModels:['model-1','model-2']}};
 const compose={...job(m,'compose','compose'),status:'completed',result:{text:'Source-grounded report',routingReason:'transport diagnostic '.repeat(500)}};
 const review=job(m,'review','review');let committed;const requests=[];
 const load=modules({'@/lib/missions/store':{readMission:async()=>({mission:m,jobs:[worker,compose,review]}),rpc:async(_,args)=>{committed=args;return true;}},'@/lib/missions/inspection':{workflowInspection:async()=>null}});
 await load('@/lib/missions/worker').executeClaim({mission:m,job:review},async(_,instruction,input)=>{
  requests.push({instruction,input});assert.ok(instruction.length<10000);assert.ok(input.length<=48000);
  return{text:JSON.stringify(instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW')?verdict():assessment),model:'independent',sources:[],calculations:[]};
 });
 assert.doesNotMatch(requests[0].input,/Source-grounded report|SOURCE_START/);
 const input=requests[1].input;assert.ok(input.includes(JSON.stringify(excerpt)));assert.ok(input.includes('a'.repeat(40)));assert.doesNotMatch(input,/transport diagnostic/);
 const contract=load('@/lib/collaboration/review-contract');for(const id of contract.acceptanceIds(assessment))assert.ok(input.includes(id));
 for(const instruction of Object.values(contract.JUDGMENT_CHECKS))assert.ok(requests[1].instruction.includes(instruction));
 assert.equal(committed.p_mission_status,'completed');assert.equal(worker.result.inspection.files[0].excerpt,excerpt);assert.ok(worker.result.routingReason.length>10000);
});
