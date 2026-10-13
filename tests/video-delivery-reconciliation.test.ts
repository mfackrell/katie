import test from "node:test";
import assert from "node:assert/strict";
import { reconcileVideoDeliveries, DELIVERY_ATTEMPT_LIMIT, DELIVERY_ROW_LIMIT } from "../lib/runpod/video-delivery-reconciliation";

type Row = { id: string; chat_request_id: string; updated_at: string; response_delivered_at: string | null };
function store(rows: Row[], touchFailures = new Set<string>(), readFails = false) {
  const reads: number[] = [];
  const db = { from(table: string) {
    assert.equal(table, "video_analysis_jobs");
    let requestId = "", update: { updated_at: string } | undefined;
    const orders: string[] = [];
    const query = {
      select(columns: string) { assert.equal(columns, "chat_request_id"); return query; },
      not(column: string, op: string, value: null) {
        assert.deepEqual([column, op, value], ["chat_request_id", "is", null]); return query;
      },
      is(column: string, value: null) {
        assert.deepEqual([column, value], ["response_delivered_at", null]); return query;
      },
      order(column: string, options: { ascending: boolean }) {
        assert.equal(options.ascending, true); orders.push(column); return query;
      },
      limit(limit: number) {
        assert.deepEqual(orders, ["updated_at", "id"]);
        reads.push(limit);
        return Promise.resolve({ error: readFails ? {} : null, data: rows
          .filter(row => !row.response_delivered_at)
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id))
          .slice(0, limit).map(row => ({ chat_request_id: row.chat_request_id })) });
      },
      update(value: { updated_at: string }) {
        assert.deepEqual(Object.keys(value), ["updated_at"]); update = value; return query;
      },
      eq(column: string, value: string) {
        assert.equal(column, "chat_request_id"); requestId = value; return query;
      },
      then(resolve: (value: { error: object | null }) => unknown) {
        const failed = touchFailures.has(requestId);
        if (!failed) for (const row of rows) {
          if (row.chat_request_id === requestId && !row.response_delivered_at) row.updated_at = update!.updated_at;
        }
        return Promise.resolve(resolve({ error: failed ? {} : null }));
      },
    };
    return query;
  } };
  return { db: db as unknown as Parameters<typeof reconcileVideoDeliveries>[0], reads };
}
function row(id: string, requestId = id, age = 0): Row {
  return { id, chat_request_id: requestId, updated_at: new Date(age).toISOString(), response_delivered_at: null };
}
const clock = () => new Date(100_000).toISOString();
const quiet = () => {};

test("newest unfinished request does not block an older ready conversation", async () => {
  const { db } = store([row("new", "new", 10_000), row("old")]);
  const calls: string[] = [];
  const result = await reconcileVideoDeliveries(db, async id => {
    calls.push(id); return { status: id === "new" ? "awaiting_submissions" : "delivered" };
  }, clock, quiet);
  assert.deepEqual(calls, ["old", "new"]);
  assert.equal(result.deliveryAttempted, 2);
  assert.equal(result.published, 1);
});

test("throwing and slow requests allow unrelated requests to proceed", async () => {
  const { db } = store([row("a"), row("b"), row("c")]);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [], errors: string[] = [];
  const running = reconcileVideoDeliveries(db, async id => {
    calls.push(id);
    if (id === "a") await blocked;
    if (id === "b") throw new Error("delivery failed");
    return { status: "delivered" };
  }, clock, id => { errors.push(id); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["a", "b", "c"]);
  release();
  const result = await running;
  assert.equal(result.published, 2);
  assert.equal(result.deliveryFailed, 1);
  assert.equal(result.deliveryAttempted, 3);
  assert.deepEqual(errors, ["b"]);
});

test("duplicate rows publish once and the entire batch rotates without touching delivered rows", async () => {
  const rows = [row("a", "batch"), row("b", "batch"), row("c", "batch")];
  rows[2].response_delivered_at = "already delivered";
  const { db } = store(rows);
  const calls: string[] = [];
  const result = await reconcileVideoDeliveries(db, async id => {
    calls.push(id); return { status: "message_changed" };
  }, clock, quiet);
  assert.deepEqual(calls, ["batch"]);
  assert.equal(result.pendingConversations, 1);
  assert.equal(result.deliveryCandidateRows, 2);
  assert.deepEqual(rows.map(r => r.updated_at), [clock(), clock(), new Date(0).toISOString()]);
});

test("bounded scheduling traverses a backlog across fresh invocations despite permanently pending or throwing requests", async () => {
  const rows = Array.from({ length: 80 }, (_, n) =>
    Array.from({ length: 5 }, (_, index) => row(`${String(n).padStart(3, "0")}-${index}`, `request-${n}`))).flat();
  const seen = new Set<string>();
  for (let run = 0; run < 20; run++) {
    const { db, reads } = store(rows); // no in-memory cursor survives invocation
    const result = await reconcileVideoDeliveries(db, async id => {
      seen.add(id);
      if (id === "request-0") throw new Error("persistent failure");
      return { status: "awaiting_grok" };
    }, () => new Date(100_000 + run * 60_000).toISOString(), quiet);
    assert.deepEqual(reads, [DELIVERY_ROW_LIMIT]);
    assert.equal(result.deliveryAttempted, DELIVERY_ATTEMPT_LIMIT);
    assert.equal(result.deliveryWindowFull, true);
    assert.equal(result.published, 0);
  }
  assert.equal(seen.size, 80);
});

test("failed scheduling writes are reported without publishing or skipping other requests", async () => {
  const { db } = store([row("a"), row("b")], new Set(["a"]));
  const calls: string[] = [];
  const result = await reconcileVideoDeliveries(db, async id => {
    calls.push(id); return { status: "delivered" };
  }, clock, quiet);
  assert.deepEqual(calls, ["b"]);
  assert.equal(result.deliveryAttempted, 1);
  assert.equal(result.deliveryFailed, 1);
  assert.equal(result.published, 1);
});

test("candidate read failures surface and empty backlogs do no work", async () => {
  await assert.rejects(reconcileVideoDeliveries(store([], new Set(), true).db,
    async () => { throw new Error("must not publish"); }), /Cannot inspect/);
  const result = await reconcileVideoDeliveries(store([]).db,
    async () => { throw new Error("must not publish"); });
  assert.equal(result.deliveryAttempted, 0);
  assert.equal(result.deliveryFailed, 0);
  assert.equal(result.pendingConversations, 0);
});
