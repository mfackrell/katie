import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('developer orchestrator owns recovery resource proposals and no automatic spend',()=>{
 const worker=readFileSync('lib/projects/worker.ts','utf8');
 const proposal=readFileSync('lib/projects/recovery-budget.ts','utf8');
 const route=readFileSync('app/api/projects/route.ts','utf8');
 assert.match(worker,/reconcileBlockedResourceApprovals/);
 assert.match(worker,/announceBlockedRecoveryResources\(p\)/);
 assert.match(proposal,/estimateProjectResources\(spec,/);
 assert.match(proposal,/Math\.max\(m\.actual_tokens\?\?0,m\.reserved_tokens\?\?0\)/);
 assert.match(proposal,/needs_specialist_estimate/);
 assert.match(proposal,/developer_resource_approval_requested/);
 assert.match(route,/export async function PATCH/);
 assert.match(route,/proposal\.scopeHash!==input\.scopeHash/);
 assert.match(route,/authorize_work_project_resources/);
 assert.match(route,/recovery:'pending_developer_orchestrator'/);
 assert.doesNotMatch(proposal,/authorize_work_project_resources/);
});
