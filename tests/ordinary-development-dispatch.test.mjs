import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
const source=readFileSync('lib/agents/development.ts','utf8');
test('ordinary continuation waits for dispatch and cannot consume the predecessor failure',async()=>{
 const start=source.indexOf('export async function reconcileDevelopment('),end=source.indexOf('  const client = github(), binding = await repository(task);',start);
 const prefix=stripTypeScriptTypes(source.slice(start,end).replace('export async','async')+'return task;}');
 let persisted;
 const reconcile=vm.runInNewContext(prefix+';reconcileDevelopment',{save:async(task,status,detail,external)=>{persisted={status,detail};return {...task,status,external};},Date});
 const task={id:'original',status:'dispatching',external:{developerApprovalId:'child',lifecycleProposalId:'proposal',receipt:{run_id:101}}};
 await reconcile(task,{});assert.match(persisted.detail,/Waiting for the authenticated ordinary resource dispatch/);
 const guard=source.split('\n').find(line=>line.includes('run.created_at')&&line.includes('developerDispatchSince'));
 const filter=new Function('task','runs',stripTypeScriptTypes('function filter(){const accepted=[];for(const run of runs){'+guard+';accepted.push(run.id);}return accepted;}')+'return filter();');
 Object.assign(task.external,{developerDispatchSince:'2026-11-01T12:00:00Z',developerReleaseSha:'new'});
 const old={id:101,created_at:'2026-11-01T11:00:00Z',head_sha:'old',event:'workflow_dispatch',status:'completed'};
 assert.deepEqual(filter(task,[old]),[],'a pending successor cannot reuse the only completed predecessor');
 assert.deepEqual(filter(task,[{...old,created_at:'2026-11-01T12:01:00Z',head_sha:'new'}]),[],'old receipt identity remains excluded');
 assert.deepEqual(filter(task,[{...old,id:102,created_at:'2026-11-01T12:01:00Z',head_sha:'new',event:'issues'}]),[]);
 assert.deepEqual(filter(task,[{...old,id:102,created_at:'2026-11-01T12:01:00Z',head_sha:'new'}]),[102]);
});
test('stopped or unverifiable ordinary rows do not starve later approvals',async()=>{
 const start=source.indexOf('async function dispatchOrdinaryNativeDevelopment()'),end=source.indexOf('  const client=github(),binding=await repository(task);',start);
 const prefix=stripTypeScriptTypes(source.slice(start,end)+'return task.id;}if(rows.data.length<8)return false;}}');
 const rows=[...Array.from({length:8},(_,i)=>({id:'stopped'+i,task_id:'stopped'+i,project_id:'p',deadline:'2099-01-01',developer_authority:{}})),{id:'live',task_id:'live',project_id:'p',deadline:'2099-01-01',developer_authority:{}}];
 let offset=0;
 const query={select(){return this},is(){return this},or(){return this},order(){return this},range(start){offset=start;return this},async returns(){return {data:rows.slice(offset,offset+8)}}};
 const seen=[];
 const run=vm.runInNewContext(prefix+';dispatchOrdinaryNativeDevelopment',{
  process:{env:{KATIE_NATIVE_BENCHMARK_DISPATCH:'enabled',VERCEL_ENV:'production',KATIE_NATIVE_HANDOFF_HMAC_KEY:'x'.repeat(32)}},Date,
  getSupabaseAdminClient:()=>({from:()=>query}),qualifiedOrdinaryDevelopmentRelease:async()=>'release',readTask:async id=>({id}),
  getDevelopmentProjectContext:async id=>{seen.push(id);if(id.startsWith('stopped'))throw Error('Approved project scope is unavailable or changed');return {projectId:'p'};}
 });
 assert.equal(await run(),'live');assert.deepEqual(seen,rows.map(r=>r.task_id));
 rows.splice(8);assert.equal(await run(),false,'all ineligible rows return control to existing benchmark dispatch paths');
});
