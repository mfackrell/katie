import test from 'node:test';
import assert from 'node:assert/strict';
import { localDayWindow, summarizeDailyUsage, type DailyAttempt } from '../lib/standalone-accounting/daily';

const attempt = (override: Partial<DailyAttempt> = {}): DailyAttempt => ({ id: 'one', actor_id: 'alice', chat_id: 'chat', provider: 'openai', model: 'model', category: 'hidden_router', state: 'settled', created_at: '2026-03-08T06:00:00.000Z', dispatched_at: '2026-03-08T06:00:00.000Z', settled_at: '2026-03-08T06:01:00.000Z', reserved_microusd: '10000', actual_microusd: '3000', usage: { inputTokens: 120, outputTokens: 20 }, ...override });

test('local midnight uses real spring and autumn DST boundaries', () => {
  const spring = localDayWindow('America/New_York', new Date('2026-03-08T12:00:00Z'));
  assert.equal(spring.start, '2026-03-08T05:00:00.000Z');
  assert.equal(spring.end, '2026-03-09T04:00:00.000Z');
  assert.equal(Date.parse(spring.end) - Date.parse(spring.start), 23 * 3600000);
  const autumn = localDayWindow('America/New_York', new Date('2026-11-01T12:00:00Z'));
  assert.equal(autumn.start, '2026-11-01T04:00:00.000Z');
  assert.equal(autumn.end, '2026-11-02T05:00:00.000Z');
  assert.equal(Date.parse(autumn.end) - Date.parse(autumn.start), 25 * 3600000);
});

test('midnight transition and fractional offset zones use their actual calendar day', () => {
  const skippedMidnight = localDayWindow('America/Sao_Paulo', new Date('2018-11-04T15:00:00Z'));
  assert.equal(skippedMidnight.start, '2018-11-04T03:00:00.000Z');
  assert.equal(skippedMidnight.end, '2018-11-05T02:00:00.000Z');
  const kathmandu = localDayWindow('Asia/Kathmandu', new Date('2026-03-08T12:00:00Z'));
  assert.equal(kathmandu.start, '2026-03-07T18:15:00.000Z');
  assert.equal(kathmandu.end, '2026-03-08T18:15:00.000Z');
  assert.throws(() => localDayWindow('invented/timezone'));
});

test('daily aggregation includes hidden helpers, partial usage, scopes, and separates prior exposure', () => {
  const rows = [attempt(), attempt({ id: 'two', state: 'uncertain', actual_microusd: null, usage: { inputTokens: 0 } }), attempt({ id: 'old', state: 'uncertain', created_at: '2026-03-07T06:00:00Z', dispatched_at: '2026-03-07T06:00:00Z', actual_microusd: null, usage: null }), attempt({ id: 'other', actor_id: 'bob', actual_microusd: '9000' }), attempt({ id: 'pending', state: 'paused', dispatched_at: null, actual_microusd: null, usage: null })];
  const daily = summarizeDailyUsage(rows, 'America/New_York', 'alice', new Date('2026-03-08T12:00:00Z'));
  assert.equal(daily.totals.attemptCount, 3);
  assert.equal(daily.totals.estimatedCostMicrousd, '3000');
  assert.equal(daily.totals.inputTokens, 120);
  assert.equal(daily.totals.missingInputCount, 0, 'known zero usage is known');
  assert.equal(daily.totals.missingOutputCount, 1);
  assert.equal(daily.totals.unknownCostCount, 1);
  assert.equal(daily.totals.pendingExposureMicrousd, '10000');
  assert.equal(daily.totals.uncertainExposureMicrousd, '10000');
  assert.equal(daily.unresolvedEarlier.uncertainExposureMicrousd, '10000');
  assert.equal(daily.models[0].category, 'hidden_router');
  const all = summarizeDailyUsage(rows, 'America/New_York', undefined, new Date('2026-03-08T12:00:00Z'));
  assert.equal(all.totals.estimatedCostMicrousd, '12000');
});

test('day membership is based on dispatch and uses an exclusive end boundary', () => {
  const daily = summarizeDailyUsage([
    attempt({ id: 'before', created_at: '2026-03-07T23:00:00.000Z', dispatched_at: '2026-03-08T05:00:00.000Z' }),
    attempt({ id: 'after', dispatched_at: '2026-03-09T04:00:00.000Z' }),
  ], 'America/New_York', undefined, new Date('2026-03-08T12:00:00Z'));
  assert.deepEqual(daily.attempts.map(value => value.id), ['before']);
});

test('money remains exact beyond the floating point safe integer limit', () => {
  const daily = summarizeDailyUsage([attempt({ actual_microusd: '9007199254740993' }), attempt({ id: 'two', actual_microusd: '7' })], 'UTC', undefined, new Date('2026-03-08T12:00:00Z'));
  assert.equal(daily.totals.estimatedCostMicrousd, '9007199254741000');
});
