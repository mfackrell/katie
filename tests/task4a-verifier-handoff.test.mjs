import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateTask4aVerifierRelease,TASK4A_HANDOFF_BASELINE as baseline,TASK4A_HANDOFF_WORKFLOWS as workflows} from '../scripts/benchmark/task4a-verifier-release.mjs';
import {modules} from './helpers/load-project-modules.mjs';
const release='f'.repeat(40),head='a'.repeat(40),tree='b'.repeat(40),repo='mfackrell/katie';
function fixture(change=()=>{}){
 const main={sha:release,parents:[{sha:baseline},{sha:head}],commit:{tree:{sha:tree}}};
 const pr={number:1028,merged:true,merge_commit_sha:release,merged_by:{login:'mfackrell'},base:{ref:'main',repo:{full_name:repo}},head:{sha:head,ref:'codex/handoff',repo:{full_name:repo}}};
 const runs=workflows.map((name,i)=>({id:100+i,workflow_id:200+i,path:'.github/workflows/'+name,head_sha:head,head_branch:pr.head.ref,event:'pull_request',repository:{full_name:repo},head_repository:{full_name:repo},pull_requests:[],status:'completed',conclusion:'success',run_attempt:1}));
 const state={main,pr,runs,headTree:tree,workflowBlob:'unchanged',mainReads:0};change(state);
 return async path=>{
 if(path.endsWith('/commits/main')){state.mainReads++;return state.mainReads>1&&state.moveMain?{...main,sha:'c'.repeat(40)}:main;}
 if(path.includes('/commits/'+release+'/pulls?'))return [{number:pr.number}];
 if(path.endsWith('/pulls/'+pr.number))return pr;
 if(path.endsWith('/commits/'+head))return {sha:head,commit:{tree:{sha:state.headTree}}};
 if(path.includes('/contents/'))return {sha:path.endsWith(baseline)?'unchanged':state.workflowBlob};
 const i=workflows.findIndex(n=>path.includes('/workflows/'+n));
 if(i<0)throw Error('Unexpected fixture request '+path);
 if(path.includes('/runs?'))return {total_count:state.extraRun?2:1,workflow_runs:state.extraRun?[runs[i],{...runs[i],id:999,conclusion:'failure'}]:[runs[i]]};
 return {id:200+i,path:'.github/workflows/'+workflows[i]};
 };
}
test('qualified target derives final production merge, stable proof, exact tree and latest trusted CI',async()=>{
 const a=await authenticateTask4aVerifierRelease(release,fixture());const b=await authenticateTask4aVerifierRelease(release,fixture());
 assert.deepEqual(a,b);assert.equal(a.releaseSha,release);assert.equal(a.qualifiedHeadSha,head);assert.equal(a.checks.length,4);
});
test('wrong production, unauthorized merge, changed source, untrusted or superseded CI fail closed',async()=>{
 for(const change of [
 s=>{s.main.sha='c'.repeat(40);},s=>{s.main.parents[0].sha=head;},s=>{s.main.parents[1].sha=baseline;},s=>{s.headTree='c'.repeat(40);},
 s=>{s.pr.merged=false;},s=>{s.pr.merged_by.login='attacker';},s=>{s.pr.base.ref='other';},s=>{s.pr.head.repo.full_name='foreign/katie';},
 s=>{s.workflowBlob='tampered';},s=>{s.runs[0].event='workflow_dispatch';},s=>{s.runs[0].workflow_id=999;},s=>{s.runs[0].head_sha=baseline;},
 s=>{s.runs[0].head_repository.full_name='foreign/katie';},s=>{s.runs[0].conclusion='failure';},s=>{s.runs[0].status='in_progress';},s=>{s.extraRun=true;},s=>{s.moveMain=true;}
 ])await assert.rejects(()=>authenticateTask4aVerifierRelease(release,fixture(change)),/UNQUALIFIED/);
});
test('owner handoff is separate, strict, authenticated and never dispatches; new release invalidates consent',async()=>{
 const old={...process.env};Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:release,KATIE_OWNER_AUTH_USER_ID:'owner'});
 const evidence=await authenticateTask4aVerifierRelease(release,fixture());
 let signed=true,qualified=true,wip=true,dispatches=0;const writes=[];
 const rows=[{id:'finance',event:'task4a_verifier_owner_authorized',data:{proposal:{releaseSha:'6b70a8fd2c48c388356b5ef371c51cb096c8a853'},result:{approvalId:'child'}}},
 {id:'replacement',event:'task4a_verifier_execution_authorized',data:{}},{id:'inference',event:'task4a_verifier_inference_authorized',data:{}}];
 const db={from:()=>({select:()=>({eq:()=>({in:()=>({returns:async()=>({data:rows,error:null})})})})}),rpc:async(name,args)=>{
 if(name.endsWith('proposal'))return {data:{ready:true,digest:'a'.repeat(64),proposal:{ownerId:'owner',checkpoint:{authenticated:true}}}};
 writes.push({name,args});rows.push({id:'handoff',event:'task4a_verifier_release_handoff_authorized',data:{proposal:{releaseSha:release,releaseEvidence:evidence}}});return {data:{authorized:true,newPaidCalls:0}};
 }};
 const route=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>signed},'@/lib/agents/development':{
 authenticatedTask4aVerifierCheckpoint:async()=>{if(!wip)throw Error('Missing WIP');return {checkpoint:{authenticated:true}};},
 qualifiedTask4aVerifierHandoffRelease:async()=>{if(!qualified)throw Error('Unqualified');return evidence;},qualifiedOrdinaryDevelopmentRelease:async()=>release,dispatchTask4aVerifierOnce:async()=>{dispatches++;return true;}}})('@/app/api/projects/task4a-verifier-recovery/route');
 const post=(action='handoff',patch={})=>route.POST(new Request('https://katie.example/api/projects/task4a-verifier-recovery',{method:'POST',body:JSON.stringify({action,digest:'a'.repeat(64),confirm:true,...patch})}));
 const get=()=>route.GET(new Request('https://katie.example/api/projects/task4a-verifier-recovery?chatId=e53defeb-16eb-457e-aa07-435141165ee8'));
 try{
 assert.equal((await (await get()).json()).action,'handoff');
 assert.equal((await post('dispatch')).status,409);
 signed=false;assert.equal((await post()).status,403);signed=true;
 assert.equal((await post('handoff',{releaseEvidence:evidence})).status,400,'Client cannot supply qualification proof');
 qualified=false;assert.equal((await post()).status,409);qualified=true;
 wip=false;assert.equal((await post()).status,409);wip=true;
 assert.equal((await post('handoff',{digest:'b'.repeat(64)})).status,409);
 assert.equal(writes.length,0);
 assert.equal((await post()).status,200);assert.equal(dispatches,0);assert.equal(writes.length,1);assert.equal(writes[0].name,'task4a_verifier_handoff_authorize');
 assert.deepEqual(writes[0].args.p_evidence,evidence);
 assert.equal((await post()).status,409);assert.equal(writes.length,1);
 assert.equal((await (await get()).json()).action,'dispatch');
 evidence.releaseSha='c'.repeat(40);assert.equal((await post('dispatch')).status,409);assert.equal(dispatches,0);
 }finally{for(const k of ['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','KATIE_OWNER_AUTH_USER_ID'])if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}
});
