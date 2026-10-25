import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const workflow=readFileSync('.github/workflows/autonomous-development.yml','utf8');
const host=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
const handoff=readFileSync('lib/agents/development.ts','utf8');
const child=readFileSync('scripts/benchmark/native-development-child.mjs','utf8');
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

test('native engineering cannot invoke unmetered review, repair, or final-review model actions',()=>{
 // Native phases must be explicitly budget-gateway-backed before being enabled.
 // A normal Codex action with the repository API key would bypass durable
 // per-request reservations and authoritative receipt settlement.
 const review=workflow.match(/\n  review:\n([\s\S]*?)\n  repair:/)?.[1];
 const repair=workflow.match(/\n  repair:\n([\s\S]*?)\n  final-review:/)?.[1];
 const finalReview=workflow.match(/\n  final-review:\n([\s\S]*?)\n  report:/)?.[1];
 assert.ok(review && repair && finalReview,'review lifecycle must exist');
 assert.match(review,/if: needs\.build\.outputs\.native != 'true'/);
 assert.match(repair,/needs\.review\.result == 'success'/);
 assert.match(finalReview,/needs\.repair\.result == 'success'/);
 // Any native paid review/repair integration must replace this fail-closed
 // barrier with an independently authorized, metered trusted-host path.
 assert.equal((review+repair+finalReview).match(/openai\/codex-action@v1/g)?.length,3);
});

test('native independent reviewers are isolated and every phase shares the metered host gateway',()=>{
 assert.match(host,/await runPhase\('implementation'\)/);
 assert.match(host,/await runPhase\('review'\)/);
 assert.match(host,/await runPhase\('repair',first\.findings\)/);
 assert.match(host,/await runPhase\('final-review'\)/);
 assert.match(host,/if\(final\.verdict!=='pass'\)denied/);
 assert.match(host,/reviewing\?'--ro-bind':'--bind'/);
 assert.match(host,/NATIVE_METERED_REVIEW_AND_BOUNDED_REPAIR_COMPLETED/);
 assert.match(host,/--ro-bind',requestFile,'\/trusted\/AGENT_REQUEST\.md'/);
 assert.match(child,/immutable owner request at \/trusted\/AGENT_REQUEST\.md/);
 assert.match(child,/KATIE_NATIVE_PHASE/);
 assert.match(child,/sandboxMode:phase==='review'\|\|phase==='final-review'\?'read-only'/);
 assert.match(child,/NATIVE_REVIEW_RESULT/);
 assert.doesNotMatch(child,/OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY/);
});

test('native completion evidence is pinned to reviewed commit and separately tested head',()=>{
 assert.match(host,/commitCandidate\('native: checkpoint approved implementation'\)/);
 assert.match(host,/commitCandidate\('native: checkpoint bounded repair'\)/);
 assert.match(host,/project-scope\.mjs/);
 assert.match(host,/reviewedHeadSha:candidateHead/);
 assert.match(workflow,/project-scope\.mjs" "\$RUNNER_TEMP\/agent-task\/AGENT_REQUEST\.md" --verify-committed/);
 assert.match(workflow,/\.reviewedHeadSha == \$head/);
 assert.match(workflow,/\.projectId == \$project/);
 assert.match(workflow,/\$TEST" == true && "\$BUILD" == success/);
 assert.match(workflow,/approved project browser acceptance is missing or failed/);
 assert.match(workflow,/if \[\[ "\$REPAIR" == success && "\$\{NATIVE:-false\}" != true \]\]/);
});
test('native reviews require immutable approved baseline and readonly execution',()=>{
 assert.match(child,/NATIVE_BASELINE_MISSING/);
 assert.match(child,/git diff /);
 assert.match(child,/baseline\+'\.\.\.HEAD'/);
 assert.match(host,/KATIE_NATIVE_BASELINE_SHA',proof\.baselineSha/);
 assert.match(host,/reviewing\?'--ro-bind':'--bind'/);
});

test('interrupted native execution retains scope-checked Git checkpoints outside the runner',()=>{
 assert.match(host,/KATIE_NATIVE_CHECKPOINT_BRANCH/);
 assert.match(host,/project-scope\.mjs/);
 assert.match(host,/recovery-scope\.mjs/);
 assert.match(host,/git\('push','origin',\`HEAD:refs\/heads\/\$\{checkpointBranch\}\`\)/);
 assert.match(workflow,/KATIE_NATIVE_CHECKPOINT_BRANCH: \$\{\{ steps\.task\.outputs\.branch \}\}/);
 assert.match(workflow,/GH_TOKEN: \$\{\{ github\.token \}\}/);
 assert.match(host,/--clearenv/);
 assert.doesNotMatch(child,/GH_TOKEN|GITHUB_TOKEN/);
});
