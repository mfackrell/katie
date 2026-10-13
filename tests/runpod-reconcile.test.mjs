import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function harness({age = 901000, race = false, writeError = false} = {}) {
  const row = {id: 'receipt', runpod_job_id: null, endpoint_id: 'yafwsm98e8m9lv', status: 'pending', submitted_at: new Date(Date.now()-age).toISOString()};
  let writes = 0;
  const client = {from: () => {
    let patch, filters = [];
    const q = {select: () => q, in: () => q, order: () => q,
      limit: async () => ({data: [{...row}]}),
      update: value => {patch = value; return q;},
      eq: (k,v) => {filters.push([k,v]); return q;},
      is: (k,v) => {filters.push([k,v]); return q;},
      maybeSingle: async () => {
        writes++;
        if (writeError) return {error: true};
        if (race) Object.assign(row, {status: 'completed', runpod_job_id: 'provider-123', analysis_text: 'late callback'});
        if (!filters.every(([k,v]) => row[k] === v)) return {data: null};
        Object.assign(row,patch); return {data: {id: row.id}};
      },
    }; return q;
  }};
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('app/api/internal/runpod-results/reconcile/route.ts','utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, {
    exports, Date, console: {warn(){},error(){}}, require: name =>
      name === 'next/server' ? {NextResponse: {json: Response.json}} :
      name.includes('durable-results') ? {ACTIVE_RUNPOD_STATES: ['pending','queued','in_progress'],assertCronAuth: () => true,resultStore: () => client} :
      name.includes('video-delivery-reconciliation') ? {reconcileVideoDeliveries: async () => ({deliveryFailed: 0})} : {},
  });
  return {row, run: async () => (await exports.GET({})).json(), get writes(){return writes;}};
}
test('unknown acceptance waits for the established Qwen budget and then records a recoverable local deadline', async () => {
  const early = harness({age: 121000}); await early.run(); assert.equal(early.writes,0);
  const late = harness(); const result = await late.run();
  assert.equal(late.row.status,'timed_out'); assert.equal(late.row.error_code,'SUBMISSION_ACCEPTANCE_UNRESOLVED_DEADLINE');
  assert.equal(result.saved,1);
});
test('deadline cleanup cannot overwrite a late callback or falsely count a save', async () => {
  const h = harness({race:true}); const result = await h.run();
  assert.equal(h.row.status,'completed'); assert.equal(h.row.analysis_text,'late callback'); assert.equal(result.saved,0);
});
test('deadline write failure is observable and preserves the pending receipt', async () => {
  const h = harness({writeError:true}); const result = await h.run();
  assert.equal(result.failed,1); assert.equal(result.saved,0); assert.equal(h.row.status,'pending');
});
