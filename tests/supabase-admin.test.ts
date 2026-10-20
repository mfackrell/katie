import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

function loadClient(t: TestContext) {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalOverride = globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__;
  const modulePath = require.resolve("../lib/data/supabase/admin");

  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key-no-network";
  delete globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__;
  delete require.cache[modulePath];
  t.after(() => {
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__ = originalOverride;
    delete require.cache[modulePath];
  });

  const { getSupabaseAdminClient } = require("../lib/data/supabase/admin") as typeof import("../lib/data/supabase/admin");
  return getSupabaseAdminClient();
}

test("conditional updates return affected rows and distinguish stale writes", async (t) => {
  const client = loadClient(t);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(init?.method, "PATCH");
    assert.equal(new Headers(init?.headers).get("Prefer"), "return=representation");
    assert.equal(url.searchParams.get("id"), "eq.saved");
    assert.equal(url.searchParams.get("actor_id"), "eq.owner");
    assert.equal(url.searchParams.get("select"), "id");
    assert.deepEqual(JSON.parse(String(init?.body)), { status: "retired" });
    return Response.json(url.searchParams.get("version") === "eq.2" ? [{ id: "saved" }] : []);
  });
  const update = (version: number) => client.from("executive_orchestrators").eq("id", "saved").eq("actor_id", "owner").eq("version", version).updateReturning<{ id: string }>({ status: "retired" }, "id");
  assert.deepEqual((await update(2)).data, [{ id: "saved" }]);
  assert.deepEqual((await update(1)).data, []);
});

test("equality filters deliver literal values after one HTTP query decode", async (t) => {
  const client = loadClient(t);
  const values = [
    "2026-10-13T19:53:26.164+00:00",
    " leading and trailing spaces ",
    "distribution & wholesale",
    "C++ / A+B",
    "100% complete; keep %20 and %2B literal",
    "https://example.test/item?actor_id=eq.other&limit=0#fragment",
    "café / 東京",
  ];
  const requests: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    // A server decodes the HTTP query once before interpreting eq.<value>.
    const filter = url.searchParams.get("value");
    const matched = values.filter((value) => filter === `eq.${value}`);
    return Response.json(matched.map((value) => ({ value })));
  });

  for (const value of values) {
    const result = await client.from("filter_examples").eq("value", value).returns<{ value: string }>();
    assert.equal(result.error, null);
    assert.deepEqual(result.data, [{ value }], `filter must match the original value: ${value}`);
    const url = requests.at(-1)!;
    assert.equal(url.searchParams.get("value"), `eq.${value}`);
    assert.deepEqual([...url.searchParams.keys()], ["select", "value"]);
    assert.equal(url.hash, "");
  }
  assert.equal(requests.length, values.length);
  assert.match(requests[0].search, /19%3A53%3A26\.164%2B00%3A00/);
  assert.doesNotMatch(requests[0].search, /%253A|%252B/);
});

test("equality encoding preserves adjacent PostgREST filters and query options", async (t) => {
  const client = loadClient(t);
  let requestUrl: URL | undefined;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requestUrl = new URL(String(input));
    return Response.json([]);
  });

  const result = await client.from("chat_requests")
    .select("request_id,status")
    .eq("attempt", 2)
    .eq("active", false)
    .eq("label", "pending & ready")
    .in("status", ["pending", "completed_with_review_notes"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .returns();

  assert.equal(result.error, null);
  assert.ok(requestUrl);
  assert.deepEqual(Object.fromEntries(requestUrl.searchParams), {
    select: "request_id,status",
    attempt: "eq.2",
    active: "eq.false",
    label: "eq.pending & ready",
    status: 'in.("pending","completed_with_review_notes")',
    order: "updated_at.desc",
    limit: "1",
  });
});

test("timestamp compare-and-set clears pending work and cannot overwrite a newer version", async (t) => {
  const client = loadClient(t);
  const originalTimestamp = "2026-10-13T19:53:26.164+00:00";
  const resolvedTimestamp = "2026-10-16T19:37:03.281+00:00";
  type MemoryRow = {
    actor_id: string;
    chat_id: string;
    updated_at: string;
    memory: { pending_request: string | null };
  };
  let row: MemoryRow = {
    actor_id: "actor-1",
    chat_id: "chat-1",
    updated_at: originalTimestamp,
    memory: { pending_request: "old-request" },
  };
  const writes: Array<{ timestamp: string | null; matched: boolean }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const matches = [...url.searchParams].every(([field, filter]) => {
      if (field === "select") return true;
      return filter === `eq.${String(row[field as keyof MemoryRow])}`;
    });
    if (init?.method === "PATCH") {
      writes.push({ timestamp: url.searchParams.get("updated_at"), matched: matches });
      if (matches) row = { ...row, ...JSON.parse(String(init.body)) };
      return new Response(null, { status: 204 });
    }
    assert.equal(init?.method, "GET");
    return matches ? Response.json(row) : new Response(null, { status: 406 });
  });

  const query = () => client.from("short_term_memory").eq("actor_id", "actor-1").eq("chat_id", "chat-1");
  const before = await query().maybeSingle<MemoryRow>();
  assert.equal(before.error, null);
  assert.equal(before.data?.memory.pending_request, "old-request");

  const cleared = await query().eq("updated_at", before.data!.updated_at).update({
    memory: { pending_request: null },
    updated_at: resolvedTimestamp,
  });
  assert.equal(cleared.error, null);
  const after = await query().maybeSingle<MemoryRow>();
  assert.equal(after.error, null);
  assert.equal(after.data?.memory.pending_request, null);
  assert.equal(after.data?.updated_at, resolvedTimestamp);

  const staleWrite = await query().eq("updated_at", originalTimestamp).update({
    memory: { pending_request: "stale-request" },
  });
  assert.equal(staleWrite.error, null);
  const readback = await query().maybeSingle<MemoryRow>();
  assert.deepEqual(readback, after);
  assert.deepEqual(writes, [
    { timestamp: `eq.${originalTimestamp}`, matched: true },
    { timestamp: `eq.${originalTimestamp}`, matched: false },
  ]);
});
