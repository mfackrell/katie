import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;

type DbState = {
  intermediate_memory: Row[];
};

class Query {
  constructor(
    private readonly state: DbState,
    private filters: Array<{ field: string; value: unknown }> = [],
  ) {}

  select() {
    return this;
  }

  eq(field: string, value: unknown) {
    this.filters.push({ field, value });
    return this;
  }

  async maybeSingle<T>() {
    const row = this.state.intermediate_memory.find((candidate) => this.matches(candidate)) ?? null;
    return { data: row as T, error: null };
  }

  async upsert(payload: Row) {
    const idx = this.state.intermediate_memory.findIndex((candidate) => {
      return candidate.actor_id === payload.actor_id && candidate.chat_id === payload.chat_id;
    });

    if (idx >= 0) {
      this.state.intermediate_memory[idx] = { ...this.state.intermediate_memory[idx], ...payload };
    } else {
      this.state.intermediate_memory.push(payload);
    }

    return { error: null };
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => row[filter.field] === filter.value);
  }
}

function createFakeClient(state: DbState) {
  return {
    from(table: keyof DbState) {
      if (table !== "intermediate_memory") {
        throw new Error(`Unexpected table requested: ${table}`);
      }

      return new Query(state);
    },
  };
}

function loadRouteHandler() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";

  const routePath = require.resolve("../app/api/memory/intermediate/route");
  const storePath = require.resolve("../lib/data/persistence-store");
  delete require.cache[routePath];
  delete require.cache[storePath];

  return require("../app/api/memory/intermediate/route") as typeof import("../app/api/memory/intermediate/route");
}

test("GET /api/memory/intermediate returns current content", async () => {
  const state: DbState = {
    intermediate_memory: [{ actor_id: "a1", chat_id: "c1", content: { summary: "hello" } }],
  };

  (globalThis as { __KATIE_SUPABASE_ADMIN_CLIENT__?: ReturnType<typeof createFakeClient> }).__KATIE_SUPABASE_ADMIN_CLIENT__ =
    createFakeClient(state);
  const { GET } = loadRouteHandler();

  const response = await GET(new NextRequest("http://localhost/api/memory/intermediate?actorId=a1&chatId=c1"));
  const payload = (await response.json()) as { content?: { summary?: string } };

  assert.equal(response.status, 200);
  assert.equal(payload.content?.summary, "hello");
});

test("PATCH /api/memory/intermediate updates existing intermediate_memory.content", async () => {
  const state: DbState = {
    intermediate_memory: [{ actor_id: "a1", chat_id: "c1", content: { summary: "before" } }],
  };

  (globalThis as { __KATIE_SUPABASE_ADMIN_CLIENT__?: ReturnType<typeof createFakeClient> }).__KATIE_SUPABASE_ADMIN_CLIENT__ =
    createFakeClient(state);
  const { PATCH } = loadRouteHandler();

  const response = await PATCH(
    new NextRequest("http://localhost/api/memory/intermediate?actorId=a1&chatId=c1", {
      method: "PATCH",
      body: JSON.stringify({ content: { summary: "after", facts: ["f1"] } }),
      headers: { "content-type": "application/json" },
    }),
  );

  const payload = (await response.json()) as { content?: { summary?: string; facts?: string[] } };
  assert.equal(response.status, 200);
  assert.equal(payload.content?.summary, "after");
  assert.deepEqual(state.intermediate_memory[0].content, { summary: "after", facts: ["f1"] });
  assert.deepEqual(Object.keys(state), ["intermediate_memory"]);
});

test("PATCH /api/memory/intermediate rejects missing actor/chat IDs", async () => {
  const state: DbState = { intermediate_memory: [] };

  (globalThis as { __KATIE_SUPABASE_ADMIN_CLIENT__?: ReturnType<typeof createFakeClient> }).__KATIE_SUPABASE_ADMIN_CLIENT__ =
    createFakeClient(state);
  const { PATCH } = loadRouteHandler();

  const response = await PATCH(
    new NextRequest("http://localhost/api/memory/intermediate?actorId=&chatId=", {
      method: "PATCH",
      body: JSON.stringify({ content: {} }),
      headers: { "content-type": "application/json" },
    }),
  );

  assert.equal(response.status, 400);
});

test("PATCH /api/memory/intermediate rejects invalid payload shape", async () => {
  const state: DbState = { intermediate_memory: [] };

  (globalThis as { __KATIE_SUPABASE_ADMIN_CLIENT__?: ReturnType<typeof createFakeClient> }).__KATIE_SUPABASE_ADMIN_CLIENT__ =
    createFakeClient(state);
  const { PATCH } = loadRouteHandler();

  const response = await PATCH(
    new NextRequest("http://localhost/api/memory/intermediate?actorId=a1&chatId=c1", {
      method: "PATCH",
      body: JSON.stringify({ content: "not-object" }),
      headers: { "content-type": "application/json" },
    }),
  );

  assert.equal(response.status, 400);
});
