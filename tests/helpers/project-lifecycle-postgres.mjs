import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {runScenarios} from '../../scripts/project-browser-engine.mjs';
import {modules} from './load-project-modules.mjs';

// Only the Supabase wire transport is replaced. All lifecycle, assignment,
// approval, claim, settlement and checkpoint RPCs execute installed PostgreSQL.
function transport(db, intercept) {
 let pending=Promise.resolve();
 const query=(sql,values)=>{const next=pending.then(async()=>{
  await db.query('savepoint wire_request');
  try{const result=await db.query(sql,values);await db.query('release savepoint wire_request');return result;}
  catch(error){await db.query('rollback to savepoint wire_request');await db.query('release savepoint wire_request');throw error;}
 });pending=next.catch(()=>{});return next;};
 const ident=s=>{assert.match(s,/^[a-z_][a-z_0-9]*$/);return '"'+s+'"';};
 const rpc=async(name,args={})=>{
  const entries=Object.entries(args), values=entries.map(([,v])=>v&&typeof v==='object'&&!Array.isArray(v)?JSON.stringify(v):Array.isArray(v)&&name==='commit_mission_work'?JSON.stringify(v):v);
  const sql=`select ${ident(name)}(${entries.map(([k],i)=>`${ident(k)} => $${i+1}`).join(',')}) value`;
  try{await intercept?.('before',name,args);const result=await query(sql,values);await intercept?.('after',name,args);return {data:result.rows[0].value,error:null};}catch(error){return {data:null,error};}
 };
 return {rpc,from(table){let fields='*',where=[],values=[],ordering='',limit='',single=false,updates;
  const q={select(v='*'){fields=v;return q;},eq(k,v){values.push(v);where.push(`${ident(k)}=$${values.length}`);return q;},in(k,v){values.push(v);where.push(`${ident(k)}=any($${values.length})`);return q;},order(k,o={}){ordering=` order by ${ident(k)} ${o.ascending===false?'desc':'asc'}`;return q;},limit(n){limit=` limit ${Number(n)}`;return q;},returns(){return q;},maybeSingle(){single=true;return q;},update(v){updates=v;return q;},then(resolve,reject){return (async()=>{
   try{const columns=fields==='*'?'*':fields.split(',').map(ident).join(',');let sql;
    if(updates){const sets=Object.entries(updates).map(([k,v])=>{values.push(v);return `${ident(k)}=$${values.length}`;});sql=`update ${ident(table)} set ${sets.join(',')}`;}else sql=`select ${columns} from ${ident(table)}`;
    sql+=(where.length?' where '+where.join(' and '):'')+ordering+limit;
    const r=await query(sql,values);return {data:single?r.rows[0]??null:r.rows,error:null};
   }catch(error){return {data:null,error};}
  })().then(resolve,reject);}};return q;}};
}
function zipJSON(body){const file=Buffer.from('agent-result.json'),content=Buffer.from(JSON.stringify(body)),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);local.writeUInt32LE(0x04034b50);local.writeUInt32LE(content.length,18);local.writeUInt32LE(content.length,22);local.writeUInt16LE(file.length,26);central.writeUInt32LE(0x02014b50);central.writeUInt32LE(content.length,20);central.writeUInt32LE(content.length,24);central.writeUInt16LE(file.length,28);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+file.length,12);end.writeUInt32LE(local.length+file.length+content.length,16);return Buffer.concat([local,file,content,central,file,end]);}

export async function verifyProjectLifecyclePostgres(db){
 await db.query('begin');
 const envKeys=['GITHUB_TOKEN','PROJECT_PREVIEW_REPOSITORIES','PROJECT_PREVIEW_HOST_PATTERN','PROJECT_PREVIEW_BYPASS_SECRET'];
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end("<!doctype html><button id='add'>Add</button><p id='stock'></p><script>let n=Number(localStorage.getItem('stock')||0);const show=()=>document.querySelector('#stock').textContent=n;show();document.querySelector('#add').onclick=()=>{localStorage.setItem('stock',++n);show()};</script>");});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const origin='http://127.0.0.1:'+server.address().port;
 const old=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
 delete process.env.PROJECT_PREVIEW_BYPASS_SECRET;
 Object.assign(process.env,{GITHUB_TOKEN:'offline-fixture',PROJECT_PREVIEW_REPOSITORIES:'owner/repo',PROJECT_PREVIEW_HOST_PATTERN:'^fixture-([a-z0-9]{9})\\.vercel\\.app$'});
 try{
  await db.query("update work_projects set status='paused' where status='running';update agent_missions set status='blocked' where status='running'");
  await db.query('reset role');
  // Metadata queried by current runtime; no authorization or lifecycle stubs.
  await db.query("alter table work_projects add column if not exists budget_authorization_source text, add column if not exists estimated_tokens bigint, add column if not exists estimate_rationale text, add column if not exists estimate_updated_at timestamptz;create table if not exists model_registry(provider_name text,model_id text,pricing_status text,pricing_input_per_1m numeric,pricing_output_per_1m numeric,pricing_verified_at timestamptz,is_active boolean)");
  await db.query('alter table benchmark_full_project_bindings add column trial_id uuid, add column benchmark_contract_hash text, add column baseline_sha text, add column model text');
  await db.query('set role service_role');
  const actor=randomUUID(),chat=randomUUID(),pid=randomUUID();
  await db.query('insert into actors(id,name) values($1,$2)',[actor,'Isolated lifecycle owner']);
  await db.query('insert into chats(id,actor_id,title) values($1,$2,$3)',[chat,actor,'Inventory lifecycle']);
  const repo=(await db.query("select id from repo_sync_runs where repository_full_name='owner/repo' limit 1")).rows[0].id;
  const contract={path:'/inventory',scenarios:[{name:'Persist stock',steps:[{action:'click',selector:'#add'},{action:'expectText',selector:'#stock',value:'1'},{action:'goto',path:'/inventory'},{action:'expectText',selector:'#stock',value:'1'}]}]};
  const plan={name:'Inventory',summary:'Persistent inventory and stock report',requirements:['Add stock, retain stock after reload, and report the same saved count.'],allowedPaths:['app/inventory/'],milestones:[{title:'Stock model',instruction:'Implement stock model and add action',contract},{title:'Persistence',instruction:'Persist stock from the verified model; restore on reload',contract},{title:'Integrated report',instruction:'Report persisted stock using the verified components',contract}],finalContract:contract};
  const rpc=async(name,args={})=>{const r=await api.rpc(name,args);if(r.error)throw r.error;return r.data;};
  const state=async()=>(await db.query('select * from work_projects where id=$1',[pid])).rows[0];
  const runs=async()=>(await db.query('select * from project_runs where project_id=$1 order by ordinal',[pid])).rows;
  const events=[],issues=[],receipts=new Map(),seenInputs=[],charges=[],fired=new Set();
  let fault=null,assessmentRejected=false,latestHead='a'.repeat(40),browserCalls=0,parallelObserved=false;
  const api=transport(db,async(when,name,args)=>{
   events.push({when,name,args});
   if(when==='after'&&name==='save_project_development_dispatch'&&args.p_status==='ready'&&!fired.has('specialist-receipt')){fired.add('specialist-receipt');throw Error('503 controlled interruption after specialist receipt persisted');}
   if(when==='after'&&name==='commit_mission_work'&&args.p_status==='completed'){
    const row=(await db.query('select role from mission_assignments where id=$1',[args.p_id])).rows[0];
    const key=row?.role==='review'?'independent-review':row?.role==='work'?'specialist-completion':null;
    if(key&&!fired.has(key)){fired.add(key);throw Error('503 controlled lost completed assignment acknowledgment');}
   }
   if(fault?.when===when&&fault.name===name&&(!fault.action||args.p_action===fault.action)){fired.add('controller:'+fault.action);fault=null;throw Error('503 controlled lost RPC acknowledgment');}
  });
  const pr=n=>{const r=receipts.get(n);return {number:n,draft:true,state:'open',merged:false,changed_files:1,html_url:r.pr_url,head:{sha:r.tested_head_sha,ref:'fixture/'+n,repo:{full_name:'owner/repo'}},base:{sha:'a'.repeat(40),repo:{full_name:'owner/repo'}}};};
  class GitHub{
   users={getAuthenticated:async()=>({data:{type:'User',login:'owner'}})};
   repos={get:async()=>({data:{default_branch:'main',owner:{type:'User',login:'owner'}}}),getBranch:async()=>({data:{commit:{sha:'a'.repeat(40)}}}),getContent:async()=>({data:{content:Buffer.from('project-browser-check.mjs projectAcceptance').toString('base64')}}),compareCommitsWithBasehead:async()=>({data:{files:[{filename:'app/inventory/page.tsx',status:'modified',additions:1,deletions:0,patch:'+ controlled external implementation fixture'}]}}),listDeployments:async({sha})=>({data:[{id:issues.length,sha,creator:{login:'vercel[bot]'},production_environment:false,environment:'Preview'}]}),listDeploymentStatuses:async({deployment_id})=>({data:[{id:deployment_id,creator:{login:'vercel[bot]'},state:'success',environment:'Preview',environment_url:'https://fixture-abc123def.vercel.app'}]})};
   issues={create:async args=>{
    const p=await state(),r=(await runs()).at(-1),number=issues.length+1;
    latestHead=number.toString(16).padStart(40,'0');
    const issue={...args,number,html_url:'https://github.com/owner/repo/issues/'+number,user:{login:'owner'}};issues.push(issue);
    receipts.set(number,{version:1,repository:'owner/repo',run_id:number,issue_number:number,pr_url:'https://github.com/owner/repo/pull/'+number,outcome:'READY',checks:{build:'success',test:'true',review:'pass',repair:'skipped',retest:'',final_review:''},tested_head_sha:latestHead,reviewed_head_sha:latestHead,projectAcceptance:{version:1,projectId:pid,contractHash:r.binding.contractHash,headSha:latestHead,passed:true,checks:contract.scenarios.map(s=>({name:s.name,passed:true,detail:'Controlled external browser receipt; not live acceptance'}))}});
    assert.equal(p.approved_hash,r.binding.scopeHash);return{data:issue};
   },listForRepo:async()=>({data:issues})};
   actions={getWorkflow:async()=>({data:{path:'.github/workflows/autonomous-development.yml',state:'active'}}),listWorkflowRuns:async()=>({data:{workflow_runs:[...receipts.keys()].reverse().map(id=>({id,status:'completed',conclusion:'success',event:'issues',repository:{full_name:'owner/repo'},head_repository:{full_name:'owner/repo'},head_branch:'main',path:'.github/workflows/autonomous-development.yml'}))}}),listWorkflowRunArtifacts:async({run_id})=>({data:{artifacts:[{id:run_id,name:'agent-completion',expired:false,size_in_bytes:5000}]}}),downloadArtifact:async({artifact_id})=>({data:zipJSON(receipts.get(artifact_id))}),listJobsForWorkflowRun:async()=>({data:{jobs:[{id:1,name:'build',conclusion:'success'}]}}),downloadJobLogsForWorkflowRun:async()=>({data:'PASS: controlled external build fixture'})};
   pulls={get:async({pull_number})=>({data:pr(pull_number)})};
  }
  const overrides={'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>api},'@octokit/rest':{Octokit:GitHub},
   '@/lib/data/persistence-store':{getChatById:async id=>{const r=(await db.query('select actor_id from chats where id=$1',[id])).rows[0];return r?{actorId:r.actor_id}:null;}},
   '@/lib/projects/specialist-dispatch':{runSpecialistResourceBatch:async()=>{}},
   '@/lib/projects/recovery-budget':{announceBlockedRecoveryResources:async()=>false},
   '@/lib/providers':{getAvailableProviders:()=>[{name:'openai'}]},'@/lib/router/master-router':{chooseProvider:async prompt=>({provider:{name:'openai'},modelId:prompt.includes('implementation')?'gpt-5.3-codex':'gpt-5.4',fallbackChain:[]})},
   '@/lib/projects/preview':{verifyDeployedPreview:async(preview,c,id)=>{
    if(!fired.has('browser-entry')){fired.add('browser-entry');throw Error('503 controlled browser entry interruption');}
    browserCalls++;
    // Real preview verifier and real Chromium contract execution. Only provider
    // transport maps the signed fixture URL to an isolated local fixture server.
    return previewModule.verifyDeployedPreview(preview,c,id,async()=>new Response('fixture'),
      async contract=>runScenarios(contract,origin,{timeout:15000}));
   }},
  };
  // Fresh module instances below model process restarts; state lives only in PG.
  const previewModule=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>api}})('@/lib/projects/preview');
  overrides['@/lib/projects/preview'].PreviewAccessUnavailable=previewModule.PreviewAccessUnavailable;
  let load=modules(overrides);
  const model=async(claim,frame,input)=>{
   const {mission:m,job:j}=claim;
   if(m.project_kind==='research'&&j.role==='work'){const n=(await db.query("select count(*)::int n from mission_assignments where mission_id=$1 and status='running'",[m.id])).rows[0].n;if(n>=2)parallelObserved=true;}
   seenInputs.push({jobId:j.id,phase:m.project_kind,role:j.role,key:j.job_key,input});
   const call=randomUUID();assert.equal(await rpc('reserve_mission_call',{p_id:j.id,p_lease:j.lease,p_call:call,p_model:'fixture',p_tokens:100}),true);
   await rpc('finish_mission_call',{p_call:call,p_tokens:50});charges.push(call);
   let text;
   if(j.role==='plan')text=JSON.stringify({assignments:[{key:'model',agentId:m.team[0].id,instruction:'Analyze stock invariants',capability:'analysis',dependencies:[]},{key:'storage',agentId:m.team[1].id,instruction:'Research storage semantics',capability:'research',dependencies:[]},{key:'integration',agentId:m.team[2].id,instruction:'Combine model and storage findings',capability:'analysis',dependencies:['model','storage']}],deliverable:'Reviewed inventory implementation evidence'});
   else if(j.role==='review'){
    const fail=m.project_kind==='assessment'&&!assessmentRejected;
    if(fail&&j.job_key==='review_again')assessmentRejected=true;
    text=JSON.stringify({verdict:fail?'revise':'approve',findings:fail?'Report does not read persisted stock.':'Verified fixture evidence',checks:load('@/lib/projects/completion').PROJECT_ACCEPTANCE_IDS.map(id=>({id,passed:!fail,evidence:fail?'Report does not read persisted stock.':'Bound controlled evidence'}))});
   }else if(m.project_kind==='specification')text=JSON.stringify(plan);
   else text=`${j.job_key}: controlled provider result for ${m.project_kind}; evidence consumed.`;
   return {text,model:'fixture',sources:[],calculations:[]};
  };
  const tick=async()=>{await db.query("update mission_assignments set available_at=now() where mission_id in(select id from agent_missions where project_id=$1)",[pid]);await load('@/lib/projects/worker').runProjectBatch();const p=await state();
   if(p.phase==='development'&&p.milestone_index===1&&p.active_mission_id&&!fired.has('specialist-lease')){
    const ready=(await db.query("select id from mission_assignments where mission_id=$1 and role='development' and status='queued' and payload->>'approved'='true'",[p.active_mission_id])).rows[0];
    if(ready){
     await db.query('update mission_assignments set available_at=now() where id=$1',[ready.id]);
     const claim=await rpc('claim_mission_work');assert.equal(claim.job.id,ready.id);
     assert.equal(await rpc('claim_mission_work'),null,'dependent composition cannot run before implementation');
     await db.query("update mission_assignments set lease_until=now()-interval '1 second' where id=$1",[ready.id]);
     assert.equal(await rpc('commit_mission_work',{p_id:ready.id,p_lease:claim.job.lease,p_result:{text:'stale worker'}}),false);
     fired.add('specialist-lease');
    }
   }
await load('@/lib/missions/worker').runMissionBatch(model);};
  await rpc('create_work_project',{p_id:pid,p_request:'lifecycle-'+pid,p_actor:actor,p_chat:chat,p_objective:'Build persistent inventory with an integrated stock report.',p_repository:repo});
  // Owner scope approval is supplied exactly once, only after real specification
  // composition, independent review and the controller's repository checks.
  let approved=null,completed=false,interrupted=new Set();
  for(let i=0;i<90;i++){
   const p=await state();
   if(p.status==='awaiting_approval'){
    assert.equal(approved,null);approved=p.approval_hash;
    await rpc('control_work_project',{p_id:pid,p_actor:actor,p_chat:chat,p_action:'approve',p_hash:approved});
   }else assert.equal(['blocked','failed'].includes(p.status),false,JSON.stringify({iteration:i,phase:p.phase,status:p.status,detail:p.detail}));
   if(p.status==='completed'){completed=true;break;}
   if(p.phase==='development'&&!p.active_mission_id&&!fired.has('parent-lease')){
    const claim=await rpc('claim_work_project');assert.equal(claim.id,pid);
    assert.equal(await rpc('claim_work_project'),null,'controller lease excludes duplicates');
    await db.query("update work_projects set lease_until=now()-interval '1 second' where id=$1",[pid]);
    assert.equal(await rpc('finish_work_project',{p_id:pid,p_lease:claim.lease,p_action:'wait'}),false,'expired parent cannot commit');
    fired.add('parent-lease');
   }
   // Lose controller responses at each transition. The next tick rereads DB;
   // no task recreation, compensating reset, or owner continuation is supplied.
   const action=p.phase==='development'?(p.active_mission_id?'advance':'child'):p.phase==='delivery'?'preview':p.phase==='browser_check'?'browser':p.phase==='assessment'&&p.active_mission_id?'complete':null;
   const key=action&&p.phase+':'+action;
   if(key&&!interrupted.has(key)){fault={when:'after',name:'finish_work_project',action};interrupted.add(key);}
   await tick();load=modules(overrides);
  }
  assert.equal(parallelObserved,true,'independent permitted work runs in parallel');
  for(const key of ['controller:child','controller:advance','controller:preview','controller:browser','controller:complete','specialist-receipt','specialist-completion','independent-review','browser-entry','parent-lease','specialist-lease'])assert.ok(fired.has(key),'fault actually exercised: '+key);
  assert.equal(completed,true,'automatic ticks must reach verified fixture completion');
  const final=await state(),history=await runs();
  assert.equal(final.id,pid);assert.equal(final.approved_hash,approved);assert.equal(final.objective,'Build persistent inventory with an integrated stock report.');
  assert.equal(final.cycles,4,'three increments plus exactly one final assessment repair');
  assert.equal(new Set(seenInputs.map(x=>x.jobId)).size,seenInputs.length,'lost acknowledgments never repeat completed provider work');
  assert.match(issues.at(-1).body,/Report does not read persisted stock/,'targeted integration findings reach the repair specialist');
  assert.equal(issues.length,4);assert.equal(browserCalls,2,'repaired head receives fresh acceptance');
  const dev=history.filter(r=>r.kind==='development');assert.deepEqual(dev.map(r=>r.milestone_index),[0,1,2,2]);
  for(let i=1;i<dev.length;i++)assert.equal(dev[i].binding.baseSha,dev[i-1].outcome.head,'each dependent increment starts from verified preceding work');
  assert.ok(seenInputs.some(x=>x.key==='integration'&&x.input.includes('model: controlled')&&x.input.includes('storage: controlled')));
  assert.ok(seenInputs.some(x=>x.phase==='assessment'&&x.input.includes('finalIntegratedEvidence')));
  const reviewRows=(await db.query("select j.agent_id,m.team from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1 and j.role='review'",[pid])).rows;
  assert.ok(reviewRows.every(r=>r.agent_id!==r.team[0].id),'reviewer differs from composer');
  assert.equal((await db.query('select count(*)::int n from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=$1',[pid])).rows[0].n,charges.length);
  const before=issues.length;await tick();assert.equal(issues.length,before);
  assert.match((await db.query('select content from messages where chat_id=$1 order by created_at desc limit 1',[chat])).rows[0].content,/Completed: Inventory/);
  console.info('PostgreSQL lifecycle verified: research dependency fan-out/join, reviewed specification, one scope approval, three cumulative development milestones, substantive assessment rejection, one bounded final repair, two real local Chromium acceptance runs, final assessment and originating-chat completion. Provider/GitHub/deployment responses and application source are controlled fixtures; browser DOM checks are real, not live application acceptance.');
 }finally{await new Promise(done=>server.close(done));for(const k of envKeys)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];await db.query('rollback');}
}
