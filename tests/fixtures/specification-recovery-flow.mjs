import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {modules} from './recovery-module-loader.mjs';
import {gameFixture} from './game-project.mjs';

// Real PostgreSQL RPCs and real project/mission workers. Only the external LLM
// response and GitHub baseline read are controlled fixtures. All admission,
// child creation, dependencies, review validation and approval fences execute.
export async function specificationRecoveryFlow(db){
 const actor='11111111-1111-4111-8111-111111111111',chat=randomUUID(),id=randomUUID();
 const original='Exact "quoted" original Counter rules. '.repeat(175).slice(0,6500);
 const clarification='Preserve keyboard and reload requirements. '.repeat(360);
 const research='Reviewed primary-source rules and supplied original decisions. '.repeat(400);
 const fixture=gameFixture();
 const spec={name:'Counter',summary:'Complete Counter game',requirements:Array.from({length:27},(_,i)=>String(i)+' '+ 'R'.repeat(490)),allowedPaths:fixture.allowedPaths,milestones:[{title:'Complete',instruction:'Preserve every original rule',contract:fixture.contract}],finalContract:fixture.contract,game:fixture.game};
 const assessment={objective:'Original Counter specification',qualifications:['Rules'],strongestEvidence:['Reviewed research'],criteria:['Every original rule '+ 'coverage '.repeat(650)],synthesis:{conclusion:'Check full Counter rules',dimensions:[{dimension:'Rules',supportedScope:'Entire specification',evidence:['Original user turns']}],emphasis:'Exact original outcome'},taskContract:{deliverable:'Specification',requirements:[{id:'source-rules',requirement:'Original Counter rules',sourceId:'latest-user',status:'active'}],conflicts:[]}};
 const priorPreview=process.env.PROJECT_PREVIEW_REPOSITORIES;
 process.env.PROJECT_PREVIEW_REPOSITORIES='owner/repo';
 await db.query('begin');
 try{
  // Isolate claims from unrelated existing fixture work, inside this rollback.
  await db.query("update work_projects set status='paused'");
  await db.query("update agent_missions set status='stopped'");
  await db.query("update mission_assignments set status='stopped',lease=null,lease_until=null where status<>'completed'");
  await db.query('insert into chats(id,actor_id,title) values($1,$2,$3)',[chat,actor,'Recovery full flow']);
  await db.query('select create_game_work_project($1,$2,$3,$4,$5,$6)',[id,'full-flow-'+id,actor,chat,original,'33333333-3333-4333-8333-333333333333']);
  await db.query('update work_projects set clarifications=$2 where id=$1',[id,clarification]);
  let p=(await db.query('select claim_work_project() p')).rows[0].p;
  await db.query("select finish_work_project($1,$2,'child',$3)",[id,p.lease,JSON.stringify({kind:'research',objective:'Research the exact supplied rules'})]);
  const researchId=(await db.query('select active_mission_id from work_projects where id=$1',[id])).rows[0].active_mission_id;
  await db.query("update agent_missions set status='completed',result=$2 where id=$1",[researchId,research]);
  await db.query("update mission_assignments set status='completed' where mission_id=$1",[researchId]);
  p=(await db.query('select claim_work_project() p')).rows[0].p;
  await db.query("select finish_work_project($1,$2,'advance',$3)",[id,p.lease,JSON.stringify({result:research,reviewedMissionId:researchId})]);
  // Reproduce the real controller's error/error/error -> blocked transition,
  // including its exhausted failure counter, rather than hand-setting blocked.
  for(let attempt=0;attempt<3;attempt++){
   p=(await db.query('select claim_work_project() p')).rows[0].p;
   await db.query("select finish_work_project($1,$2,'error',$3)",[id,p.lease,JSON.stringify({detail:'Project coordination error: Project milestone context exceeds its bounded input.'})]);
  }
  p=(await db.query('select * from work_projects where id=$1',[id])).rows[0];assert.equal(p.status,'blocked');assert.equal(p.failures,3);

  const oversizedResearch=research;
  await db.query('update agent_missions set result=$2 where id=$1',[researchId,oversizedResearch]);
  const sourceWords=`ORIGINAL USER OUTCOME (must remain authoritative):\n${original}\n${clarification}`;
  const oversizedEvidence={projectProfile:'game',originalUserOutcome:sourceWords,reviewedResearch:{text:oversizedResearch,reviewedMissionId:researchId,phase:'research'}};
  assert.ok(sourceWords.length<30000&&oversizedResearch.length<30000&&JSON.stringify(oversizedEvidence).length>30000&&JSON.stringify(oversizedEvidence).length<60000);
  assert.equal((await db.query('select resume_oversized_game_specification($1,$2,$3,$4) ok',[id,actor,chat,JSON.stringify({...oversizedEvidence,unadmittedMetadata:'x'.repeat(30000)})])).rows[0].ok,false);


  const rpc=async(name,args={})=>{
   assert.match(name,/^[a-z_]+$/);if(name==='project_dispatch_recovery_candidates')return[];
   const entries=Object.entries(args);
   const values=entries.map(([k,v])=>['p_data','p_result','p_children','p_response','p_evidence','p_preflight'].includes(k)?JSON.stringify(v):v);
   try{return(await db.query(`select public.${name}(${entries.map(([k],i)=>k+' => $'+(i+1)).join(',')}) value`,values)).rows[0].value;}catch(error){console.error('Recovery fixture RPC',name,error.message);throw error;}
  };
  const readMission=async mid=>({mission:(await db.query('select * from agent_missions where id=$1',[mid])).rows[0],jobs:(await db.query('select * from mission_assignments where mission_id=$1 order by created_at',[mid])).rows});
  const admin={from(table){
   assert.match(table,/^[a-z_]+$/);let fields='*',conditions=[],values=[],sort='',count='',offset='';
   const q={select(v){fields=v;return q;},eq(k,v){values.push(v);conditions.push(k+'=$'+values.length);return q;},order(k,o){sort=' order by '+k+(o?.ascending?' asc':' desc');return q;},limit(n){count=' limit '+n;return q;},range(a,b){count=' limit '+(b-a+1);offset=' offset '+a;return q;},not(){return q;},async maybeSingle(){const r=await q;return{data:r.data[0]??null,error:null};},then(resolve,reject){return db.query('select '+fields+' from '+table+(conditions.length?' where '+conditions.join(' and '):'')+sort+count+offset,values).then(r=>resolve({data:r.rows,error:null}),reject);}};return q;
  }};
  class GitHub{users={getAuthenticated:async()=>({data:{login:'owner',type:'User'}})};repos={get:async()=>({data:{default_branch:'main',owner:{type:'User'}}}),getBranch:async()=>({data:{commit:{sha:'a'.repeat(40)}}}),getContent:async({path})=>({data:{content:Buffer.from(path.endsWith('project-context.mjs')?'export const GAME_PROJECT_CONTEXT_VERSION=1;':path.endsWith('project-ci.mjs')?'checkGameModel(context,root,dependencies)':path.endsWith('project-game-check.mjs')?'runGameModelAcceptance':path.endsWith('project-game-rules.mjs')?'export function validateGameAcceptance export function runGameModelAcceptance':'project-browser-check.mjs projectAcceptance project-game-check.mjs project-game-rules.mjs').toString('base64')}})};}
  const runs=async()=> (await db.query('select * from project_runs where project_id=$1 order by ordinal',[id])).rows;
  const milestoneEvidence=async rows=>Promise.all(rows.filter(r=>r.outcome).map(async r=>({phase:r.kind,index:r.milestone_index,result:(await readMission(r.mission_id)).mission.result,missionStatus:(await readMission(r.mission_id)).mission.status,evidence:r.outcome})));
  const load=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>admin},'@/lib/missions/store':{rpc,readMission},'@/lib/projects/store':{projectRpc:rpc,projectRuns:runs,milestoneEvidence},'@octokit/rest':{Octokit:GitHub}});
  const projectWorker=load('@/lib/projects/worker'),missionWorker=load('@/lib/missions/worker');
  // The complete combined brief and reviewed research exceed the old 30K
  // fence. The phase-specific lossless path admits them together and progresses
  // through the real workers, without inventing replacement research records.
  assert.equal(Number((await db.query("select count(*) n from project_events where project_id=$1 and event='oversized_game_specification_resumed'",[id])).rows[0].n),0);
  await projectWorker.runProjectBatch();
  p=(await db.query('select * from work_projects where id=$1',[id])).rows[0];assert.equal(p.status,'running');assert.equal(p.active_mission_id,null);
  assert.equal(Number((await db.query("select count(*) n from project_events where project_id=$1 and event='oversized_game_specification_resumed'",[id])).rows[0].n),1);
  await projectWorker.runProjectBatch();
  p=(await db.query('select * from work_projects where id=$1',[id])).rows[0];
  assert.equal(p.status,'running');assert.ok(p.active_mission_id);
  assert.equal((await readMission(researchId)).mission.result,oversizedResearch);
  assert.equal(Number((await db.query("select count(*) n from project_runs where project_id=$1 and kind='research'",[id])).rows[0].n),1);
  const source=(await readMission(p.active_mission_id)).mission;
  assert.equal(source.project_evidence.originalUserOutcome,`ORIGINAL USER OUTCOME (must remain authoritative):\n${original}\n${clarification}`);
  assert.equal(source.project_evidence.reviewedResearch.text,research);
  assert.ok(source.objective.length<=12000);
  let passes=0,sawRevision=false,modelCalls=0;
  const model=async(claim,instruction,input)=>{
   modelCalls++;
   assert.equal(load('@/lib/missions/request-budget').fitsMissionEnvelope(instruction,input,load('@/lib/missions/request-budget').missionInputLimit(claim)),true);
   // Exercise the exact same atomic execution admission that missionModel uses.
   const callId=randomUUID();assert.equal(await rpc('reserve_mission_call',{p_id:claim.job.id,p_lease:claim.job.lease,p_call:callId,p_model:'fixture:independent',p_tokens:Math.ceil(Buffer.byteLength(input)/4)+10000}),true);
   await rpc('finish_mission_call',{p_call:callId,p_tokens:100});
   const reviewing=claim.job.role==='review',candidatePass=instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW');
   if(reviewing&&!candidatePass)assert.ok(input.includes(JSON.stringify(original).slice(1,-1)));
   if(claim.job.role==='revise'){sawRevision=true;const data=JSON.parse(input.split('\nReview findings: ')[0]);assert.equal(data.projectEvidence.originalUserOutcome,source.project_evidence.originalUserOutcome);assert.equal(data.projectEvidence.reviewedResearch.text,research);assert.ok(input.length>48000&&input.length<=128000);}
   let text=JSON.stringify(spec);
   if(reviewing){
    if(candidatePass){passes++;const approved=passes>1;const ids=load('@/lib/collaboration/review-contract').acceptanceIds(assessment);text=JSON.stringify({verdict:approved?'approve':'revise',findings:approved?'Exact original rules and entire revised candidate verified':'Correct substantive rule proof. '+ 'Missing boundary-state evidence. '.repeat(85),checks:ids.map(id=>({id,passed:approved,evidence:approved?'Rule and expected state verified':'Missing required rule proof'}))});}
    else text=JSON.stringify(assessment);
   }
   return{text,sources:[],calculations:[],model:'fixture-independent'};
  };
  for(let n=0;n<5;n++){const claim=await rpc('claim_mission_work');assert.ok(claim,'Expected phase worker '+n);await missionWorker.executeClaim(claim,model);}
  assert.equal(passes,2);assert.equal(sawRevision,true);assert.equal(modelCalls,6);
  await projectWorker.runProjectBatch();
  p=(await db.query('select * from work_projects where id=$1',[id])).rows[0];
  assert.equal(p.status,'awaiting_approval');assert.equal(p.phase,'approval');assert.equal(p.approved_hash,null);assert.ok(p.approval_hash);assert.deepEqual(p.spec,spec);

  // Recover an expired/incomplete review, then exercise ACTUAL missionModel
  // counting, admission and checkpoint persistence against PostgreSQL. The
  // provider transport returns controlled independent review JSON.
  const sourceMission=source.id;
  await db.query("update work_projects set status='blocked',phase='specification',spec=null,approval_hash=null,approved_hash=null,active_mission_id=$2 where id=$1",[id,sourceMission]);
  await db.query("update agent_missions set status='blocked',deadline=now()-interval '1 minute',reserved_tokens=60000,actual_tokens=60000 where id=$1",[sourceMission]);
  await db.query("update mission_assignments set status='failed',detail='Model output incomplete: incomplete',result='{\"responseStatus\":\"incomplete\",\"incompleteReason\":\"max_output_tokens\"}' where mission_id=$1 and job_key='review_again'",[sourceMission]);
  await db.query("update work_projects set token_allowance=80000 where id=$1",[id]);
  assert.equal(await rpc('resume_incomplete_game_review',{p_id:id,p_actor:actor,p_chat:chat}),true);
  const continued=(await db.query('select active_mission_id from work_projects where id=$1',[id])).rows[0].active_mission_id;
  let counts=0,generations=0;
  const priorKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';
  try{
   class ProviderClient{
    async post(){counts++;return{input_tokens:counts===1?1000:12000};}
    responses={create:async()=>{generations++;const ids=load('@/lib/collaboration/review-contract').acceptanceIds(assessment);
     return{status:'completed',output_text:JSON.stringify(generations===1?assessment:{verdict:'approve',findings:'Entire saved candidate checked',checks:ids.map(id=>({id,passed:true,evidence:'Exact original rules checked against saved candidate'}))}),output:[],usage:{total_tokens:100}};
    }};
   }
   const real=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>admin},'@/lib/missions/store':{rpc,readMission},
    '@/lib/orchestration/routing':{orchestrationChoices:async()=>[{provider:{name:'openai'},modelId:'fixture-reviewed-model',reasoning:'Controlled transport'}],orchestrationFailure:async()=> 'model'},
    openai:{__esModule:true,default:ProviderClient}})('@/lib/missions/worker');
   const first=await real.runMissionBatch();assert.equal(first.outcomes[0].status,'blocked');
   let saved=await readMission(continued),review=saved.jobs.find(j=>j.job_key==='review_again');
   assert.equal(saved.mission.calls,1);assert.equal(saved.mission.actual_tokens,100);assert.equal(review.result.admissionDenied,true);assert.ok(review.payload.reviewModelCheckpoint);
   const checkpoint=JSON.stringify(review.payload.reviewModelCheckpoint),attempts=review.attempts;
   await projectWorker.runProjectBatch();
   // Actual admission failure, exhausted deferrals and real expired claims
   // each get one bounded replacement; old charges/deadlines stay immutable.
   for(const failure of ['expired_admission','deferred_lease','expired_claim']){
    await db.query('savepoint technical_recovery');
    const previousCounts=counts,previousGenerations=generations;
    try{
     if(failure==='expired_admission'){
      await db.query("update agent_missions set deadline=now()-interval '1 minute' where id=$1",[continued]);
      assert.equal(await rpc('resume_incomplete_game_review',{p_id:id,p_actor:actor,p_chat:chat}),false,'Expired admission without increased capacity stays pending');
     }else{
      await db.query("update work_projects set status='running' where id=$1",[id]);
      await db.query("update agent_missions set status='running' where id=$1",[continued]);
      await db.query("update mission_assignments set status='queued',attempts=$2,available_at=now() where mission_id=$1 and job_key='review_again'",[continued,failure==='expired_claim'?1:0]);
      if(failure==='expired_claim'){
       const claim=await rpc('claim_mission_work');assert.equal(claim.job.attempts,2);
       await db.query("update mission_assignments set lease_until=now()-interval '1 minute' where id=$1",[claim.job.id]);
       assert.equal(await rpc('claim_mission_work'),null);
      }else{
       const nearExpiryRpc=async(name,args)=>{const value=await rpc(name,args);if(name==='claim_mission_work'&&value){
        await db.query("update mission_assignments set lease_until=now()+interval '20 seconds' where id=$1",[value.job.id]);
        value.job.lease_until=new Date(Date.now()+20000).toISOString();
       }return value;};
       const deferredModules=modules({'@/lib/missions/store':{rpc:nearExpiryRpc,readMission},
        '@/lib/orchestration/routing':{orchestrationChoices:async()=>[{provider:{name:'openai'},modelId:'fixture-reviewed-model',reasoning:'Controlled transport'}],orchestrationFailure:async()=> 'model'},openai:{__esModule:true,default:ProviderClient}});
       const deferred=deferredModules('@/lib/missions/worker');
       for(let n=0;n<3;n++){await db.query("update mission_assignments set available_at=now() where mission_id=$1 and job_key='review_again'",[continued]);await deferred.runMissionBatch(deferredModules('@/lib/missions/model').missionModel);}
       const failed=(await readMission(continued)).jobs.find(j=>j.job_key==='review_again');assert.equal(failed.status,'failed',JSON.stringify(failed));assert.equal(failed.result.reviewStageDeferred,true);assert.equal(failed.attempts,3);
      }
     }
     await db.query("update work_projects set status='blocked',token_allowance=120000 where id=$1",[id]);
     const old=await readMission(continued);
     assert.equal(await rpc('resume_incomplete_game_review',{p_id:id,p_actor:actor,p_chat:chat}),true,failure+' must recover');
     const child=(await db.query('select active_mission_id from work_projects where id=$1',[id])).rows[0].active_mission_id;
     assert.notEqual(child,continued);
     const fresh=await readMission(child);assert.equal(JSON.stringify(fresh.jobs.find(j=>j.job_key==='review_again').payload.reviewModelCheckpoint),checkpoint);
     assert.equal(fresh.jobs.find(j=>j.job_key==='revision').result.text,old.jobs.find(j=>j.job_key==='revision').result.text);
     assert.equal((await real.runMissionBatch()).outcomes[0].status,'processed');
     assert.equal(generations,previousGenerations+1,'Only candidate verification runs on a checkpointed replacement');
     const preserved=await readMission(continued);assert.equal(preserved.mission.actual_tokens,old.mission.actual_tokens);assert.equal(String(preserved.mission.deadline),String(old.mission.deadline));assert.equal(preserved.jobs.find(j=>j.job_key==='review_again').attempts,old.jobs.find(j=>j.job_key==='review_again').attempts);
     await projectWorker.runProjectBatch();assert.equal((await db.query('select status from work_projects where id=$1',[id])).rows[0].status,'awaiting_approval');
     await db.query("update work_projects set status='blocked',phase='specification',spec=null,approval_hash=null where id=$1",[id]);
     await db.query("update agent_missions set status='blocked' where id=$1",[child]);
     await db.query("update mission_assignments set status='failed',result='{\"reviewStageDeferred\":true}' where mission_id=$1 and job_key='review_again'",[child]);
     assert.equal(await rpc('resume_incomplete_game_review',{p_id:id,p_actor:actor,p_chat:chat}),false,'Technical replacement is bounded per exact candidate');
    }finally{await db.query('rollback to savepoint technical_recovery');counts=previousCounts;generations=previousGenerations;}
   }
   assert.equal(await rpc('resume_pending_game_review',{p_id:id,p_actor:actor,p_chat:chat}),false,'Unchanged denial must not loop');
   await db.query('update work_projects set token_allowance=120000 where id=$1',[id]);
   assert.equal(await rpc('resume_pending_game_review',{p_id:id,p_actor:actor,p_chat:chat}),true);
   assert.equal((await db.query('select active_mission_id from work_projects where id=$1',[id])).rows[0].active_mission_id,continued);
   assert.equal((await readMission(continued)).jobs.find(j=>j.job_key==='review_again').attempts,attempts);
   const next=await real.runMissionBatch();assert.equal(next.outcomes[0].status,'processed');
   saved=await readMission(continued);assert.equal(saved.mission.status,'completed');assert.equal(generations,2,'The checkpointed assessment must not be generated again');assert.equal(counts,3);
   assert.equal(JSON.stringify(saved.jobs.find(j=>j.job_key==='review_again').payload.reviewModelCheckpoint),checkpoint);
   assert.equal((await readMission(sourceMission)).mission.actual_tokens,60000,'Source charges remain unchanged');
   await projectWorker.runProjectBatch();p=(await db.query('select * from work_projects where id=$1',[id])).rows[0];assert.equal(p.status,'awaiting_approval');assert.equal(p.approved_hash,null);
  }finally{if(priorKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=priorKey;}

  // A recovered FIRST review may reject its draft, produce a new valid
  // revision, and then lose review_again to incomplete output. Recover that
  // NEW exact candidate, not a recursive replay of the first candidate hash.
  const technicalSource=randomUUID(),initialSpec={...spec,summary:'First candidate in a separate incomplete-review lifecycle'},revisedSpec={...spec,summary:'Revised candidate after substantive independent findings'};
  const originalMission=await readMission(source.id),lead=originalMission.mission.team[0].id,reviewer=originalMission.mission.team[1].id;
  await db.query("insert into agent_missions(id,objective,team,status,max_calls,token_allowance,max_minutes,deadline,project_id,project_kind,project_evidence) values($1,$2,$3,'blocked',12,120000,120,now()-interval '1 minute',$4,'specification',$5)",[technicalSource,source.objective,JSON.stringify(source.team),id,JSON.stringify(source.project_evidence)]);
  await db.query("insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,status,result) values($1,'plan','plan',$2,'Saved phase plan','completed','{}'),($1,'compose','compose',$2,'Saved complete candidate','completed',$3),($1,'review','review',$4,'Independent specification review','failed','{\"responseStatus\":\"incomplete\",\"incompleteReason\":\"max_output_tokens\"}')",[technicalSource,lead,JSON.stringify({text:JSON.stringify(initialSpec)}),reviewer]);
  await db.query("update mission_assignments set dependencies=array['compose'] where mission_id=$1 and role='review'",[technicalSource]);
  await db.query("insert into project_runs(project_id,mission_id,kind,ordinal,milestone_index) values($1,$2,'specification',(select count(*)+1 from project_runs where project_id=$1),0)",[id,technicalSource]);
  await db.query("update work_projects set status='blocked',phase='specification',spec=null,approval_hash=null,approved_hash=null,token_allowance=600000,active_mission_id=$2 where id=$1",[id,technicalSource]);
  assert.equal(await rpc('resume_incomplete_game_review',{p_id:id,p_actor:actor,p_chat:chat}),true);
  const firstContinuation=(await db.query('select active_mission_id from work_projects where id=$1',[id])).rows[0].active_mission_id;
  let answerReviews=0,blindGenerations=0;
  const originalKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';
  try{
   class Client{
    async post(){return{input_tokens:1000};}
    responses={create:async request=>{
     const input=request.input[0].content;
     if(input.startsWith('AUTHORITATIVE_USER_TURNS:')){blindGenerations++;return{status:'completed',output_text:JSON.stringify(assessment),output:[],usage:{total_tokens:100}};}
     if(request.instructions.includes('KATIE_REQUIRED_DRAFT_REVIEW')){
      answerReviews++;
      if(answerReviews===2)return{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[],usage:{total_tokens:100}};
      const approved=answerReviews>2,ids=load('@/lib/collaboration/review-contract').acceptanceIds(assessment);
      return{status:'completed',output_text:JSON.stringify({verdict:approved?'approve':'revise',findings:approved?'Revised rule proof verified':'Repair required rule proof',checks:ids.map(id=>({id,passed:approved,evidence:approved?'Revised expected state verified':'Missing original boundary proof'}))}),output:[],usage:{total_tokens:100}};
     }
     return{status:'completed',output_text:JSON.stringify(revisedSpec),output:[],usage:{total_tokens:100}};
    }};
   }
   const worker=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>admin},'@/lib/missions/store':{rpc,readMission},
    '@/lib/orchestration/routing':{orchestrationChoices:async()=>[{provider:{name:'openai'},modelId:'fixture-reviewed-model',reasoning:'Controlled transport'}],orchestrationFailure:async()=> 'model'},openai:{__esModule:true,default:Client}})('@/lib/missions/worker');
   assert.equal((await worker.runMissionBatch()).outcomes[0].status,'processed');
   assert.equal((await worker.runMissionBatch()).outcomes[0].status,'processed');
   assert.equal((await worker.runMissionBatch()).outcomes[0].status,'blocked');
   await projectWorker.runProjectBatch();
   const before=await readMission(firstContinuation),newText=before.jobs.find(j=>j.job_key==='revision').result.text;
   assert.equal(JSON.parse(newText).summary,revisedSpec.summary);
   assert.equal(await rpc('resume_incomplete_game_review',{p_id:id,p_actor:actor,p_chat:chat}),true,'A new revised candidate needs its own review continuation');
   const secondContinuation=(await db.query('select active_mission_id from work_projects where id=$1',[id])).rows[0].active_mission_id;
   assert.notEqual(secondContinuation,firstContinuation);
   assert.equal((await readMission(secondContinuation)).jobs.find(j=>j.job_key==='revision').result.text,newText);
   assert.equal((await worker.runMissionBatch()).outcomes[0].status,'processed');
   assert.equal(blindGenerations,2,'review_again reuses its exact saved blind checkpoint after continuation');
   assert.equal((await readMission(firstContinuation)).mission.calls,before.mission.calls);
   await projectWorker.runProjectBatch();p=(await db.query('select * from work_projects where id=$1',[id])).rows[0];assert.equal(p.status,'awaiting_approval');assert.equal(p.spec.summary,revisedSpec.summary);assert.equal(p.approved_hash,null);
  }finally{if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey;}

  // Known review overflow must preflight the real source-matching assessment
  // and complete candidate before spending a child slot or candidate marker.
  const contextMission=(await db.query("select mission_id from project_runs where project_id=$1 and kind='specification' order by ordinal desc limit 1",[id])).rows[0].mission_id;
  const contextCandidate={...spec,summary:'Distinct saved candidate for exact review-context preflight'};
  await db.query("update mission_assignments set result=$2 where mission_id=$1 and job_key='revision'",[contextMission,JSON.stringify({text:JSON.stringify(contextCandidate)})]);
  await db.query("update work_projects set status='running',phase='specification',spec=null,approval_hash=null,approved_hash=null,active_mission_id=$2,failures=0 where id=$1",[id,contextMission]);
  await db.query("update agent_missions set status='running' where id=$1",[contextMission]);
  await db.query("update mission_assignments set status='queued',available_at=now(),lease=null,lease_until=null,result=null,payload='{}' where mission_id=$1 and job_key='review_again'",[contextMission]);
  const largeAssessment={...assessment,criteria:Array.from({length:2700},(_,i)=>'Criterion '+i)};
  assert.ok(JSON.stringify(largeAssessment).length<50000);
  const oldApiKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';
  try{
   class OverflowClient{async post(){return{input_tokens:1000};}responses={create:async()=>({status:'completed',output_text:JSON.stringify(largeAssessment),output:[],usage:{total_tokens:100}})};}
   const overrides={'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>admin},'@/lib/missions/store':{rpc,readMission},'@/lib/orchestration/routing':{orchestrationChoices:async()=>[{provider:{name:'openai'},modelId:'fixture-reviewed-model',reasoning:'Controlled transport'}],orchestrationFailure:async()=> 'model'}};
   const overflowWorker=modules({...overrides,openai:{__esModule:true,default:OverflowClient}})('@/lib/missions/worker');
   assert.equal((await overflowWorker.runMissionBatch()).outcomes[0].status,'blocked');
   let saved=await readMission(contextMission),failed=saved.jobs.find(j=>j.job_key==='review_again');
   assert.equal(failed.result.reviewContextOverflow,true);assert.ok(failed.result.reviewInputCharacters>128000);assert.ok(failed.payload.reviewModelCheckpoint);
   await projectWorker.runProjectBatch();
   const originalText=saved.jobs.find(j=>j.job_key==='revision').result.text;
   const originalReceipt=JSON.stringify(failed.payload.reviewModelCheckpoint);
   const beforeSlots=Number((await db.query('select count(*) n from project_runs where project_id=$1',[id])).rows[0].n);
   const beforeMarkers=Number((await db.query("select count(*) n from project_events where project_id=$1 and event='incomplete_game_review_resumed'",[id])).rows[0].n);
   assert.equal(await overflowWorker.preflightSavedReview(saved,failed),null);
   assert.equal(await rpc('resume_incomplete_game_review',{p_id:id,p_actor:actor,p_chat:chat}),false,'A known oversized review cannot consume recovery without preflight');
   assert.equal(Number((await db.query('select count(*) n from project_runs where project_id=$1',[id])).rows[0].n),beforeSlots);
   assert.equal(Number((await db.query("select count(*) n from project_events where project_id=$1 and event='incomplete_game_review_resumed'",[id])).rows[0].n),beforeMarkers);
   saved=await readMission(contextMission);assert.equal(saved.jobs.find(j=>j.job_key==='revision').result.text,originalText);assert.equal(JSON.stringify(saved.jobs.find(j=>j.job_key==='review_again').payload.reviewModelCheckpoint),originalReceipt);
   // Production schedules a bounded, charged, draft-blind reassessment. The
   // original complete receipt is archived by SQL; no test edits the checkpoint.
   await projectWorker.runProjectBatch();
   p=(await db.query('select * from work_projects where id=$1',[id])).rows[0];assert.equal(p.status,'running');assert.notEqual(p.active_mission_id,contextMission);
   const reassessment=await readMission(p.active_mission_id),freshJob=reassessment.jobs.find(j=>j.job_key==='review_again');
   assert.equal(freshJob.payload.assessmentRefresh,true);assert.equal(freshJob.payload.reviewModelCheckpoint,undefined);
   assert.equal(reassessment.jobs.find(j=>j.job_key==='revision').result.text,originalText);
   const archived=(await db.query("select data->'priorAssessment' receipt from project_events where project_id=$1 and event='independent_assessment_refresh_started' order by created_at desc limit 1",[id])).rows[0].receipt;
   assert.equal(JSON.stringify(archived),originalReceipt);
   let calls=0;
   class CompactClient{async post(){return{input_tokens:1000};}responses={create:async request=>{calls++;const blind=request.input[0].content.startsWith('AUTHORITATIVE_USER_TURNS:');if(blind)assert.match(request.instructions,/BOUNDED_INDEPENDENT_REASSESSMENT/);return{status:'completed',output_text:JSON.stringify(blind?assessment:{verdict:'approve',findings:'Entire original source and preserved candidate checked',checks:load('@/lib/collaboration/review-contract').acceptanceIds(assessment).map(id=>({id,passed:true,evidence:'Original rule and complete candidate verified'}))}),output:[],usage:{total_tokens:100}};}};}
   const compactWorker=modules({...overrides,openai:{__esModule:true,default:CompactClient}})('@/lib/missions/worker');
   assert.equal((await compactWorker.runMissionBatch()).outcomes[0].status,'processed');assert.equal(calls,2,'Fresh independent assessment and candidate verification are both charged');assert.equal((await readMission(reassessment.mission.id)).mission.actual_tokens,200);assert.equal(JSON.stringify((await readMission(contextMission)).jobs.find(j=>j.job_key==='review_again').payload.reviewModelCheckpoint),originalReceipt);
   await projectWorker.runProjectBatch();p=(await db.query('select * from work_projects where id=$1',[id])).rows[0];assert.equal(p.status,'awaiting_approval');assert.equal(p.spec.summary,contextCandidate.summary);assert.equal(p.approved_hash,null);
  }finally{if(oldApiKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldApiKey;}

 }finally{await db.query('rollback');if(priorPreview===undefined)delete process.env.PROJECT_PREVIEW_REPOSITORIES;else process.env.PROJECT_PREVIEW_REPOSITORIES=priorPreview;}
}
