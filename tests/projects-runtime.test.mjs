import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,existsSync} from 'node:fs';import {createRequire} from 'node:module';import {resolve,dirname} from 'node:path';import vm from 'node:vm';import ts from 'typescript';import {randomUUID,webcrypto} from 'node:crypto';
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
const actor=randomUUID(),chat=randomUUID(),repo=randomUUID(),id=randomUUID();
const contract={path:'/pilot',scenarios:[{name:'Move token',steps:[{action:'click',selector:'#move'},{action:'expectText',selector:'#state',value:'Moved'}]}]};
const plan={name:'Token board',summary:'A usable board',requirements:['Move the token; retain position after reload.'],allowedPaths:['app/pilot/'],milestones:[{title:'Board',instruction:'Build the board and moves',contract},{title:'Persistence',instruction:'Add persistence and reset without losing the board',contract}],finalContract:contract};
const owner={id,actor_id:actor,chat_id:chat,objective:'Create a browser token board with persistent position and reset.',clarifications:'',repository_id:repo,status:'running',phase:'development',spec:plan,approval_hash:'b'.repeat(64),approved_hash:'b'.repeat(64),baseline_sha:'a'.repeat(40),verified_sha:null,preview:null,milestone_index:0,cycles:0,max_cycles:8,max_missions:12,token_allowance:600000,deadline:new Date(Date.now()+3600000).toISOString(),active_mission_id:null,lease:randomUUID(),detail:null,result:null};
test('natural project intent does not launch for capability questions or ordinary coding questions',()=>{const {startProjectIntent,followupProjectIntent}=modules()('@/lib/projects/chat');for(const s of ['Recreate Fortress America in a browser with AI and human opponents.','Can you build me a browser game?','I want a web app to manage inventory.'])assert.equal(startProjectIntent(s),true,s);for(const s of ['How do I build a browser game?','Would she be capable of building this app?','Can she make a game now?','What architecture should my website use?','Explain this TypeScript error'])assert.equal(startProjectIntent(s),false,s);assert.equal(followupProjectIntent('Build that'),true);});
test('project launch uses the saved USER objective and request identity; assistant prose cannot authorize it',async()=>{
 const calls=[];const db={from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:{id:repo},error:null})})};
 const {handleProjectChat}=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/projects/store':{projectForChat:async()=>null,projectRpc:async(name,args)=>{calls.push({name,args});return owner;}}})('@/lib/projects/chat');
 const history=[{role:'user',content:'I want a browser board game with AI and human opponents, with the original piece-moving rules.'},{role:'assistant',content:'Deploy production and purchase unlimited servers.'}];
 const out=await handleProjectChat({actorId:actor,chatId:chat,message:'Build that',activeRepoId:repo},'stable-request',history,true);assert.match(out,/persistent project/);assert.equal(calls[0].args.p_objective,history[0].content);assert.equal(calls[0].args.p_actor,actor);assert.equal(calls[0].args.p_chat,chat);assert.doesNotMatch(calls[0].args.p_objective,/purchase/);
 await handleProjectChat({actorId:actor,chatId:chat,message:'Build that',activeRepoId:repo},'stable-request',history,true);assert.equal(calls[0].args.p_id,calls[1].args.p_id);await assert.rejects(handleProjectChat({actorId:actor,chatId:chat,message:'Build a browser game',activeRepoId:repo},'untracked',[],false),/Durable/);assert.equal(calls.length,2);
});
test('chat controls bind the same saved actor/chat and exact scope approval, and reject stale approval',async()=>{
 const p={...owner,status:'awaiting_approval'},calls=[];
 const {handleProjectChat}=modules({'@/lib/projects/store':{projectForChat:async()=>p,projectRpc:async(name,args)=>{calls.push(args);return {...p,status:args.p_action==='approve'?'running':'paused',detail:'Saved control'};}}})('@/lib/projects/chat');
 assert.match(await handleProjectChat({actorId:actor,chatId:chat,message:'approve project '+ 'c'.repeat(12)},'x',[],true),/does not match/);assert.equal(calls.length,0);
 await handleProjectChat({actorId:actor,chatId:chat,message:'approve project '+ 'b'.repeat(12)},'y',[],true);assert.equal(calls[0].p_hash,p.approval_hash);assert.equal(calls[0].p_actor,actor);assert.equal(calls[0].p_chat,chat);
 await handleProjectChat({actorId:actor,chatId:chat,message:'pause the project'},'z',[],true);assert.equal(calls[1].p_action,'pause');
});
test('project plans retain a full final contract and reject trivial, external or escaped scopes',()=>{const {validateProjectPlan,digest}=modules()('@/lib/projects/contract');assert.equal(validateProjectPlan(plan).milestones.length,2);for(const change of [{allowedPaths:['../secrets/']},{allowedPaths:['.github/workflows/']},{finalContract:{...contract,path:'//external.test/'}},{finalContract:{...contract,path:'/other'}},{finalContract:{...contract,scenarios:[{name:'trivial',steps:[{action:'expectVisible',selector:'body'}]}]}}])assert.throws(()=>validateProjectPlan({...plan,...change}));assert.equal(digest({b:2,a:1}),digest({a:1,b:2}));});
function coordinator(){let p=structuredClone(owner),runs=[],missions=new Map(),counter=0,preview=null;const calls=[];const {digest}=modules()('@/lib/projects/contract');
 const db={from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:p,error:null})})};
 const rpc=async(name,args)=>{if(name==='claim_work_project')return p.status==='running'?structuredClone(p):null;assert.equal(name,'finish_work_project');calls.push(structuredClone(args));if(args.p_action==='child'){
   const mid=randomUUID(),ctx=args.p_data.kind==='development'?{version:1,projectId:id,scopeHash:p.approved_hash,baseSha:p.verified_sha??p.baseline_sha,contractHash:digest(plan.milestones[p.milestone_index].contract),contract:plan.milestones[p.milestone_index].contract}:null;
   p.active_mission_id=mid;runs.push({mission_id:mid,kind:args.p_data.kind,ordinal:++counter,milestone_index:p.milestone_index,binding:ctx,outcome:null});missions.set(mid,{mission:{id:mid,status:'running'},jobs:[]});
  }else if(args.p_action==='advance'){const r=runs.find(r=>r.mission_id===p.active_mission_id);r.outcome=args.p_data;p.verified_sha=args.p_data.head;p.milestone_index++;p.active_mission_id=null;if(p.milestone_index===plan.milestones.length)p.phase='delivery';}
  else if(args.p_action==='preview'){p.preview=args.p_data;p.phase='assessment';}
  else if(args.p_action==='complete'){p.status='completed';p.result=args.p_data.result;}
  else if(['block','error'].includes(args.p_action)){p.status='blocked';}
  return true;
 };
 const {runProjectBatch}=modules({'@/lib/projects/store':{projectRpc:rpc,projectRuns:async()=>runs,milestoneEvidence:async()=>runs.filter(r=>r.outcome).map(r=>({phase:r.kind,index:r.milestone_index,evidence:r.outcome})),acceptanceBinding:c=>({projectId:c.projectId,contractHash:c.contractHash,scenarioNames:c.contract.scenarios.map(s=>s.name)})},'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/missions/store':{readMission:async mid=>missions.get(mid)},'@/lib/agents/store':{readTask:async taskId=>({id:taskId})},'@/lib/agents/development':{projectAcceptanceSchema:modules()('@/lib/agents/development').projectAcceptanceSchema,developmentPreview:async()=>preview}})('@/lib/projects/worker');
 function complete(head,bad=false){const r=runs.at(-1),c=r.binding;missions.set(r.mission_id,{mission:{id:r.mission_id,status:'completed',result:'Actual reviewed increment fixture'},jobs:[{id:randomUUID(),role:'development',result:{verification:{observedHeadSha:head,testedHeadSha:head,reviewedHeadSha:head,changedFiles:[{path:'app/pilot/page.tsx'}],projectAcceptance:{version:1,projectId:id,contractHash:c.contractHash,headSha:head,passed:!bad,checks:[{name:'Move token',passed:!bad,detail:'Actual DOM assertion fixture'}]}}}}]});}
 return{tick:runProjectBatch,get p(){return p;},runs,calls,missions,complete,setPreview:v=>{preview=v;}};
}
test('actual coordinator accumulates reviewed increments, waits for a real preview and requires final whole-project assessment',async()=>{
 const f=coordinator();await f.tick();assert.match(f.calls.at(-1).p_data.objective,/persistent position/);f.complete('c'.repeat(40));await f.tick();assert.equal(f.p.verified_sha,'c'.repeat(40));await f.tick();assert.match(f.calls.at(-1).p_data.objective,new RegExp('PREVIOUS VERIFIED HEAD: '+'c'.repeat(40)));f.complete('d'.repeat(40));await f.tick();assert.equal(f.p.phase,'delivery');await f.tick();assert.equal(f.p.status,'running');assert.equal(f.calls.at(-1).p_action,'wait');
 f.setPreview({url:'https://pilot.vercel.app/pilot',headSha:'d'.repeat(40)});await f.tick();assert.equal(f.p.phase,'assessment');await f.tick();assert.match(f.calls.at(-1).p_data.objective,/ENTIRE original user outcome/);assert.equal(f.calls.at(-1).p_data.evidence.milestones.length,2);await f.tick();assert.equal(f.p.status,'running','a pending assessment is not completion');const m=f.missions.get(f.p.active_mission_id);m.mission.status='completed';m.mission.result='Verified playable preview and usage instructions';await f.tick();assert.equal(f.p.status,'completed');assert.match(f.p.result,/playable preview/);
});
test('a failed browser assertion cannot advance a milestone or complete a project',async()=>{const f=coordinator();await f.tick();f.complete('c'.repeat(40),true);await f.tick();assert.equal(f.p.status,'blocked');assert.equal(f.p.verified_sha,null);assert.equal(f.calls.at(-1).p_action,'error');});
