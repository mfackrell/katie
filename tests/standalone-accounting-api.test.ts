import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET as usage } from '../app/api/standalone-accounting/usage/route';
import { PATCH as configure } from '../app/api/standalone-accounting/configuration/route';
import { POST as decide } from '../app/api/standalone-accounting/attempts/route';
import { freezePreparedRequest, estimatePreparedRequest } from '../lib/standalone-accounting/estimate';
import { PRICING_VERSION } from '../lib/standalone-accounting/pricing';
import type { LedgerAttempt } from '../lib/standalone-accounting/types';

const owner = '11111111-1111-4111-8111-111111111111', actorId = '22222222-2222-4222-8222-222222222222', chatId = '33333333-3333-4333-8333-333333333333', attemptId = '44444444-4444-4444-8444-444444444444';
const prepared = freezePreparedRequest('openai', 'gpt-4o', '/v1/responses', { model: 'gpt-4o', input: 'private saved prompt', max_output_tokens: 8192 });
let exposureAccepted=false;
let parentStatus='paused', parentError:string|null=null;
let calls: Array<{ name: string; args: Record<string, unknown> }> = [], allowed = true, verifiedOwner = owner, row: LedgerAttempt, events: Array<Record<string, unknown>> = [];
function request(path: string, body?: unknown, token = true) { return new NextRequest(`http://localhost/api/standalone-accounting/${path}`, { ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), headers: { ...(token ? { authorization: 'Bearer verified-token' } : {}), 'content-type': 'application/json' } }); }
function decision(action: 'approve_once' | 'reduce_cost' | 'cancel') { return { actorId, chatId, attemptId, action, preparedHash: prepared.hash, pricingVersion: PRICING_VERSION, budgetRevision: 7, reservedMicrousd: '100000' }; }

beforeEach(() => {
  exposureAccepted=false;parentStatus='paused';parentError=null;calls = []; allowed = true; verifiedOwner = owner; events = [];
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://auth.example.test'; process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key';
  globalThis.fetch = async () => new Response(JSON.stringify({ id: verifiedOwner }), { headers: { 'content-type': 'application/json' } });
  row = { id: attemptId, owner_id: owner, actor_id: actorId, chat_id: chatId, request_id: 'saved-request', attempt_key: '0', base_attempt_key: '0', source_prepared_hash: prepared.hash, supersedes_attempt_id: null, tradeoffs: null, prepared_hash: prepared.hash, prepared_payload: prepared as unknown as Record<string, unknown>, pricing_version: PRICING_VERSION, provider: 'openai', model: 'gpt-4o', category: 'hidden_router', preflight_estimate: estimatePreparedRequest(prepared) as unknown as Record<string, unknown>, estimator_version: 'standalone-estimator-v1', reason: 'Hidden router request', resolved_model: 'gpt-4o', state: 'paused', reserved_microusd: '100000', actual_microusd: null, budget_revision: 7, usage: null, evidence: null, provider_receipt_id: null, provider_request_id: null, provider_response_id: null, response_checkpoint: null, pause_reason: 'per_call_threshold', cancelled_by_owner_at: null, created_at: new Date().toISOString(), dispatched_at: null, settled_at: null };
  const db = {
    from: () => {
      const filters: Record<string, unknown> = {};
      const query = { select() { return query; }, eq(field: string, value: unknown) { filters[field] = value; return query; }, async maybeSingle() { return { data: allowed && filters.owner_id === owner && filters.actor_id === actorId && filters.chat_id === chatId ? { owner_id: owner } : null, error: null }; } };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if(name==='standalone_load_workflow')return{data:{status:parentStatus,error:parentError},error:null};
      if (name === 'standalone_uncertain_exposure_accepted') return {data:exposureAccepted,error:null};
      if (name === 'standalone_accept_uncertain_exposure') return {data:{accepted_at:'2026-10-29T20:00:00Z'},error:null};
      if (name === 'standalone_register_pricing') return { data: true, error: null };
      if (name === 'standalone_authorize_scope') return { data: allowed && args.p_owner === owner && args.p_actor === actorId && args.p_chat === chatId, error: null };
      if (name === 'standalone_snapshot') return { data: { configuration: { owner_id: owner, timezone: 'UTC', per_call_limit_microusd: '1000', request_limit_microusd: '5000', budget_revision: 7 }, attempts: [row], events }, error: null };
      if (name === 'standalone_cancel') {
        row = { ...row, state: ['paused', 'reserved'].includes(row.state) ? 'cancelled' : row.state === 'settled' ? 'settled' : 'uncertain', cancelled_by_owner_at: new Date().toISOString() };
        return { data: row, error: null };
      }
      return { data: { ...row, state: name === 'standalone_cancel' ? 'cancelled' : name === 'standalone_revise' ? 'paused' : 'reserved' }, error: null };
    },
  };
  globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__ = db as unknown as NonNullable<typeof globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__>;
});

test('API requires verified owner and provisioned saved association before reading ledger', async () => {
  assert.equal((await usage(request(`usage?actorId=${actorId}&chatId=${chatId}`, undefined, false))).status, 403);
  assert.equal(calls.length, 0);
  verifiedOwner = '99999999-9999-4999-8999-999999999999';
  assert.equal((await usage(request(`usage?actorId=${actorId}&chatId=${chatId}`))).status, 403);
  assert.ok(!calls.some(call => call.name === 'standalone_snapshot'));
});

test('daily response includes canonical ledger values but never prepared prompt', async () => {
  row.state = 'settled'; row.dispatched_at = row.created_at; row.actual_microusd = '99'; row.usage = { inputTokens: 12, outputTokens: 4 };
  const response = await usage(request(`usage?actorId=${actorId}&chatId=${chatId}`));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes('private saved prompt'));
  const body = JSON.parse(text);
  assert.equal(body.daily.totals.inputTokens, 12);
  assert.equal(body.daily.totals.estimatedCostMicrousd, '99');
  assert.equal(body.daily.models[0].category, 'hidden_router');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('exact approval records only that attempt and never dispatches or starts a provider', async () => {
  const response = await decide(request('attempts', decision('approve_once')));
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(call => call.name), ['standalone_authorize_scope', 'standalone_snapshot', 'standalone_approve']);
  assert.equal(calls[2].args.p_owner, owner);
  assert.equal(calls[2].args.p_attempt, attemptId);
  assert.equal(calls[2].args.p_hash, prepared.hash);
});

test('changed approval revision and other-chat attempt cannot be approved', async () => {
  assert.equal((await decide(request('attempts', { ...decision('approve_once'), budgetRevision: 6 }))).status, 409);
  assert.ok(!calls.some(call => call.name === 'standalone_approve'));
  row.chat_id = '55555555-5555-4555-8555-555555555555';
  assert.equal((await decide(request('attempts', decision('approve_once')))).status, 404);
});

test('reduce cost freezes a genuinely smaller revision and requires review without dispatch', async () => {
  const response = await decide(request('attempts', decision('reduce_cost')));
  assert.equal(response.status, 200);
  const revision = calls.find(call => call.name === 'standalone_revise');
  assert.ok(revision);
  assert.ok(calls.findIndex(call => call.name === "standalone_register_pricing") < calls.findIndex(call => call.name === "standalone_revise"), "A fresh immutable price snapshot must exist before the revised quote is stored");
  assert.ok(BigInt(revision.args.p_reserved as string) < 100000n);
  assert.notEqual(revision.args.p_hash, prepared.hash);
  assert.match(revision.args.p_tradeoffs as string, /smaller output allowance/i);
  assert.ok(!calls.some(call => /approve|dispatch/.test(call.name)));
});

test('configuration requires explicit valid timezone and thresholds rather than invented defaults', async () => {
  const response = await configure(request('configuration', { actorId, chatId, timezone: 'invented/zone', perCallLimitMicrousd: '1', requestLimitMicrousd: '2' }));
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await configure(request('configuration', { actorId, chatId, timezone: 'UTC' }))).status, 400);
});

test('pending preview describes sizing, output allowance, original-request exposure and uncertainty without exposing payload', async () => {
  const response = await usage(request(`usage?actorId=${actorId}&chatId=${chatId}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.pending[0].preview.outputAllowance, 8192);
  assert.ok(body.pending[0].preview.textBytes > 0);
  assert.ok(body.pending[0].preview.assumptions.length > 0);
  assert.equal(body.pending[0].requestExposure.pendingExposureMicrousd, '100000');
  assert.equal(body.pending[0].preview.imageCount, 0);
  assert.ok(!JSON.stringify(body).includes('private saved prompt'));
});

test('cancel uses durable cancellation without admitting or dispatching a new attempt', async () => {
  const response = await decide(request('attempts', decision('cancel')));
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(call => call.name), ['standalone_authorize_scope', 'standalone_snapshot', 'standalone_cancel']);
});

test('proposal uses immutable saved preflight evidence rather than recomputing current estimator', async () => {
  row.preflight_estimate = { ...row.preflight_estimate, outputAllowance: 31, assumptions: ['Saved historical estimator assumption.'] };
  const body = await (await usage(request(`usage?actorId=${actorId}&chatId=${chatId}`))).json();
  assert.equal(body.pending[0].preview.outputAllowance, 31);
  assert.deepEqual(body.pending[0].preview.assumptions, ['Saved historical estimator assumption.']);
  assert.equal(body.pending[0].estimatorVersion, 'standalone-estimator-v1');
  assert.equal(body.pending[0].reason, 'Hidden router request');
  assert.equal(body.pending[0].pauseReason, 'per_call_threshold');
});

test('overrun and conflicting receipt surface distinct alerts without changing ledger totals', async () => {
  row.state = 'settled'; row.dispatched_at = row.created_at; row.actual_microusd = '120000'; row.usage = { inputTokens: 12, outputTokens: 4 };
  events = [{ id: 'conflict', owner_id: owner, attempt_id: attemptId, kind: 'receipt_conflict', details: { privateEvidence: 'do not expose' }, created_at: row.created_at }];
  const body = await (await usage(request(`usage?actorId=${actorId}&chatId=${chatId}`))).json();
  assert.deepEqual(body.alerts.map((alert: { kind: string }) => alert.kind), ['overrun', 'receipt_conflict']);
  assert.equal(body.daily.totals.estimatedCostMicrousd, '120000');
  assert.ok(!JSON.stringify(body).includes('do not expose'));
});

test('active saved attempts remain cancellable after approval and include only the current conversation', async () => {
  for (const state of ['reserved', 'dispatched', 'uncertain'] as const) {
    row.state = state;
    const body = await (await usage(request(`usage?actorId=${actorId}&chatId=${chatId}`))).json();
    assert.equal(body.active[0].id, attemptId);
    assert.equal(body.active[0].state, state);
    assert.equal(body.active[0].preparedHash, prepared.hash);
    assert.equal(body.active[0].reservedMicrousd, '100000');
    assert.equal(body.pending.length, 0);
    assert.ok(!JSON.stringify(body.active).includes('private saved prompt'));
  }
  row.chat_id = '55555555-5555-4555-8555-555555555555';
  assert.equal((await (await usage(request(`usage?actorId=${actorId}&chatId=${chatId}`))).json()).active.length, 0);
});

test('post-dispatch cancellation returns successful held-exposure status without approving or resuming work', async () => {
  row.state = 'dispatched'; row.dispatched_at = row.created_at;
  const response = await decide(request('attempts', decision('cancel')));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.cancellationRequested, true);
  assert.equal(body.state, 'uncertain');
  assert.equal(body.heldExposureMicrousd, '100000');
  assert.match(body.message, /spending exposure remains held/);
  assert.deepEqual(calls.map(call => call.name), ['standalone_authorize_scope', 'standalone_snapshot', 'standalone_cancel']);
  const snapshot = await (await usage(request(`usage?actorId=${actorId}&chatId=${chatId}`))).json();
  assert.equal(snapshot.active.length, 0, 'already cancelled work is not offered another cancel action');
  assert.equal(snapshot.daily.totals.uncertainExposureMicrousd, '100000', 'cancellation cannot erase dispatched spending exposure');
});


test('accept exposure authenticates the exact uncertain attempt and uses current owner revision',async()=>{
 row={...row,state:'uncertain',budget_revision:1};
 const body={actorId,chatId,attemptId,action:'accept_exposure',preparedHash:row.prepared_hash,pricingVersion:row.pricing_version,budgetRevision:7,reservedMicrousd:row.reserved_microusd};
 const result=await decide(request('attempts',body));assert.equal(result.status,200);
 assert.equal((await result.json()).heldExposureMicrousd,row.reserved_microusd);assert.equal(row.state,'uncertain');
 const call=calls.find(call=>call.name==='standalone_accept_uncertain_exposure')!;
 assert.equal(call.args.p_owner,owner);assert.equal(call.args.p_revision,7);assert.equal(call.args.p_reserved,row.reserved_microusd);
 allowed=false;const before=calls.length;
 assert.equal((await decide(request('attempts',body))).status,403);assert.equal(calls.length,before+1,'only scope authorization runs for a revoked owner');
 allowed=true;
 assert.equal((await decide(request('attempts',{...body,reservedMicrousd:'1'}))).status,409);
 assert.equal((await decide(request('attempts',{...body,budgetRevision:1}))).status,409);
 assert.equal((await decide(request('attempts',{...body,exposureAccepted:true}))).status,400,'browser flags cannot supply continuation authority');
});

test('Qwen known jobs expose polling but no browser job identity and fixed reservations cannot be token-reduced',async()=>{
 row.provider='runpod';row.model='Qwen/Qwen3-VL-8B-Instruct';row.pricing_version='standalone-runpod-qwen-still-v1';row.provider_request_id='saved-runpod-job-123';row.state='dispatched';
 const response=await usage(request(`usage?actorId=${actorId}&chatId=${chatId}`));const body=await response.json();
 assert.equal(body.active[0].pollableRunpod,true);assert.ok(!JSON.stringify(body).includes('saved-runpod-job-123'));
 row.state='paused';const reduce=await decide(request('attempts',{...decision('reduce_cost'),pricingVersion:row.pricing_version}));
 assert.equal(reduce.status,409);assert.match((await reduce.json()).error,/fixed reviewed infrastructure reservation/);
 assert.ok(!calls.some(c=>c.name==='standalone_load_pricing'||c.name==='standalone_revise'));
});

test('uncertain financial exposure is actionable only while its parent is paused and resumable',async()=>{
 row.state='uncertain';
 for(const status of ['paused','completed','running','failed']){
   parentStatus=status;
   const response=await usage(request(`usage?actorId=${actorId}&chatId=${chatId}`));
   const body=await response.json();assert.equal(body.active[0].parentStatus,status);
   assert.equal(body.active[0].continuationActionable,status==='paused');
   assert.equal(body.active[0].cancellationActionable,status==='paused');
   assert.equal(body.active[0].reservedMicrousd,'100000');
 }
 parentStatus='failed';parentError='standalone_no_priceable_vision: independent blocker';
 const body=await (await usage(request(`usage?actorId=${actorId}&chatId=${chatId}`))).json();
 assert.match(body.active[0].continuationBlockedReason,/independent blocker/);assert.equal(body.active[0].continuationActionable,false);
});

test('running reserved/dispatched work remains cancellable without offering resume or accept',async()=>{
 parentStatus='running';
 for(const state of ['reserved','dispatched'] as const){row.state=state;
   const body=await (await usage(request(`usage?actorId=${actorId}&chatId=${chatId}`))).json();
   assert.equal(body.active[0].continuationActionable,false);assert.equal(body.active[0].cancellationActionable,true);
 }
});

test('durable automatic uncertainty is informational for paused and completed parents, with full retained accounting',async()=>{
 row.state='uncertain';row.provider='runpod';row.reserved_microusd='20000';exposureAccepted=true;
 events=[{attempt_id:row.id,kind:'uncertain_exposure_auto_authorized'}];
 for(const status of ['paused','completed']){parentStatus=status;
 const body=await (await usage(request(`usage?actorId=${actorId}&chatId=${chatId}`))).json();
 assert.equal(body.active[0].uncertainAutoAuthorized,true);assert.equal(body.active[0].continuationActionable,false);assert.equal(body.active[0].cancellationActionable,false);assert.equal(body.active[0].reservedMicrousd,'20000');}
});
