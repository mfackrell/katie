import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const workflow=readFileSync('.github/workflows/autonomous-development.yml','utf8');
const host=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
const handoff=readFileSync('lib/agents/development.ts','utf8');
const grant=readFileSync('supabase/migrations/20261025211500_benchmark_approved_dispatch_activation.sql','utf8');
test('existing owner-only engineering workflow selects signed native host without Codex action bypass',()=>{
 assert.match(workflow,/native-dispatch-cli\.mjs\" verify/);
 assert.match(workflow,/if: steps\.task\.outputs\.native != 'true'\n        uses: openai\/codex-action@v1/);
 assert.match(workflow,/name: Run approved native Developer through trusted gateway/);
 assert.match(workflow,/native-development-host\.mjs/);
 assert.match(workflow,/if: needs\.build\.outputs\.native != 'true'/);
 assert.match(handoff,/benchmark_native_spending_approvals/);
 assert.match(handoff,/encodeNativeHandoff/);
 assert.match(handoff,/claim_project_dispatch/);
});
test('native paid gateway never inherits provider or Supabase credentials',()=>{
 assert.match(host,/KATIE_BENCHMARK_PAID_EXECUTION!=='enabled'/);
 assert.match(host,/--unshare-all/);
 assert.match(host,/--clearenv/);
 assert.match(host,/benchmark_reconcile_linked_receipt/);
 assert.match(host,/fullMission:true/);
 assert.match(host,/NATIVE_DEVELOPER_RETURNED_TO_EXISTING_TEST_REVIEW_PIPELINE/);
 assert.match(grant,/a\.task_id is null/);
 assert.match(grant,/state='running'/);
});
