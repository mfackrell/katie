import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {modules} from './helpers/load-project-modules.mjs';
import {savedTask4aPlan,savedTask4aFinalReview,oldPath,newPath} from './fixtures/task4a-saved-specification.mjs';

const load=modules();
const {validateProjectPlan,digest}=load('@/lib/projects/contract');
const {prepareTask4aSavedRecovery}=load('@/lib/projects/task4a-saved-specification-recovery');

test('Task 4A saved-path repair uses actual complete validator and never changes browser acceptance',()=>{
 const original=savedTask4aPlan(),review=savedTask4aFinalReview(),raw=JSON.stringify(original);
 assert.throws(()=>validateProjectPlan(original),/Scope requires isolated application\/source\/test paths/);
 const output=prepareTask4aSavedRecovery(raw,raw,review);
 assert.deepEqual(Array.from(output.corrected.allowedPaths),[newPath]);
 assert.equal(output.corrected.finalContract.path,oldPath);
 assert.equal(digest(output.corrected.milestones),digest(original.milestones));
 assert.equal(digest(output.corrected.finalContract),digest(original.finalContract));
 assert.equal(digest(output.corrected.requirements),digest(original.requirements));
 assert.equal(output.sourceReviewOnly,true);
 assert.equal(output.sourceHash,digest(original));
 assert.equal(output.correctedHash,digest(output.corrected));
 assert.notEqual(output.sourceHash,output.correctedHash);
 assert.throws(()=>prepareTask4aSavedRecovery(raw,JSON.stringify({...original,name:'changed'}),review),/differs/);
 assert.throws(()=>prepareTask4aSavedRecovery(raw,raw,{...review,verdict:'changes_requested'}),/PASS/);
 assert.throws(()=>prepareTask4aSavedRecovery(JSON.stringify({...original,allowedPaths:['lib/secrets/']}),raw,review),/differs|expected artifact/);
 assert.throws(()=>prepareTask4aSavedRecovery(JSON.stringify({...original,allowedPaths:[newPath]}),JSON.stringify({...original,allowedPaths:[newPath]}),review),/not the verified path error|expected artifact/);
});

test('Task 4A repair endpoint cannot act without owner sign-in and exact saved source consent',async()=>{
 const projectId='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
 const chat='e53defeb-16eb-457e-aa07-435141165ee8',missionId='20a837cb-98ae-470f-8308-8526d8dceed3';
 const actor=randomUUID(),raw=JSON.stringify(savedTask4aPlan()),review=savedTask4aFinalReview();
 const p={id:projectId,actor_id:actor,chat_id:chat,status:'failed',phase:'specification',
  active_mission_id:missionId,approved_hash:null,spec:null,repository_id:randomUUID(),
  deadline:new Date(Date.now()+24*3600000).toISOString()};
 const mission={id:missionId,project_kind:'specification',status:'completed',result:raw};
 const jobs=[
  {id:'08a62aa5-e4c0-49a3-ae9d-ae5b77275a71',job_key:'revision',role:'revise',status:'completed',result:{text:raw}},
  {id:'dd46bc5a-50cf-49fe-a8dd-ab36e52d6d73',job_key:'review_again',role:'review',status:'completed',result:review}
 ];
 let owner=false,commits=0,baselineCalls=0,failed=false;
 const db={
  from(table){
   return {
    select(){return this;},eq(){return this;},in(){return this;},
    maybeSingle:async()=>({data:table==='work_projects'?p:table==='agent_missions'?mission:
     table==='project_continuation_authorizations'?{id:randomUUID(),revoked_at:null,deadline:new Date(Date.now()+3600000).toISOString()}:null,error:null}),
    returns:async()=>({data:jobs,error:null})
   };
  },
  rpc:async(name,args)=>{
   assert.equal(name,'recover_task4a_reviewed_specification');
   assert.equal(args.p_actor,actor);
   assert.equal(args.p_chat,chat);
   assert.equal(args.p_baseline_sha,'a'.repeat(40));
   assert.equal(args.p_source_hash,digest(savedTask4aPlan()));
   assert.equal(args.p_corrected_hash,digest(args.p_corrected));
   commits++;
   return {data:{recovered:true,receiptId:randomUUID(),status:'awaiting_approval',scopeHash:'b'.repeat(64)},error:null};
  }
 };
 const {GET,POST}=modules({
  'next/server':{NextResponse:{json:(value,options)=>Response.json(value,options)}},
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},
  '@/lib/projects/worker':{baseline:async()=>{baselineCalls++;return 'a'.repeat(40);}}
 })('@/app/api/projects/task4a-specification-recovery/route');
 const request=(body)=>new Request('https://katie.local/api/projects/task4a-specification-recovery',{
  method:'POST',headers:{Origin:'https://katie.local','Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await GET(new Request('https://katie.local/api/projects/task4a-specification-recovery'))).status,401);
 assert.equal((await POST(request({confirm:true,sourceHash:digest(savedTask4aPlan())}))).status,403);
 assert.equal(commits,0);assert.equal(baselineCalls,0);
 owner=true;
 const preflight=await GET(new Request('https://katie.local/api/projects/task4a-specification-recovery'));
 assert.equal(preflight.status,200);
 const ready=await preflight.json();
 assert.equal(ready.ready,true);
 assert.equal(ready.scopeApprovalStillRequired,true);
 assert.equal((await POST(request({confirm:false,sourceHash:ready.sourceHash}))).status,400);
 assert.equal((await POST(request({confirm:true,sourceHash:'f'.repeat(64)}))).status,409);
 assert.equal(commits,0);
 const result=await POST(request({confirm:true,sourceHash:ready.sourceHash}));
 assert.equal(result.status,200);
 const receipt=await result.json();
 assert.equal(receipt.recovered,true);
 assert.equal(receipt.scopeApprovalStillRequired,true);
 assert.equal(receipt.developmentDispatched,false);
 assert.equal(receipt.spendingAuthorized,false);
 assert.equal(commits,1);assert.equal(baselineCalls,1);
 p.status='awaiting_approval';
 assert.equal((await POST(request({confirm:true,sourceHash:ready.sourceHash}))).status,409);
 assert.equal(commits,1);
 p.status='failed';
 failed=true;void failed;
});
