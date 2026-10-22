import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sql=readFileSync('supabase/migrations/20261022174500_specialist_estimate_dispatch.sql','utf8');
const dispatcher=readFileSync('lib/projects/specialist-dispatch.ts','utf8');
const coordinator=readFileSync('lib/projects/worker.ts','utf8');
test('mission admission is project-budget-fenced, unique, and server-owned',()=>{
 assert.match(sql,/charged\+12000>p.token_allowance/);
 assert.match(sql,/PRIMARY KEY\(project_id,scope_hash,package_id\)/);
 assert.match(sql,/FOR UPDATE SKIP LOCKED/);
 assert.match(sql,/PERFORM create_mission/);
 assert.match(sql,/project_kind='resource_estimate'/);
 assert.match(sql,/REVOKE ALL ON FUNCTION public.dispatch_specialist_resource_estimate/);
 assert.match(sql,/project_specialist_consolidations/);
 assert.match(sql,/recorded_count<>package_count/);
});
test('completed specialist results are attributed to reviewed missions and reconciled',()=>{
 assert.match(dispatcher,/recordAndReconcileSpecialistEstimate/);
 assert.match(dispatcher,/mission.status!=='completed'/);
 assert.match(dispatcher,/p.approval_hash!==entry.scope_hash/);
 assert.match(dispatcher,/save_project_specialist_consolidation/);
 assert.match(coordinator,/runSpecialistResourceBatch\(\)/);
});
