import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;

type DbState = {
  actors: Row[];
  chats: Row[];
  messages: Row[];
  short_term_memory: Row[];
  intermediate_memory: Row[];
  long_term_memory: Row[];
};

class Query {
  constructor(
    private readonly state: DbState,
    private readonly table: keyof DbState,
    private readonly mode: "select" | "update" = "select",
    private payload: Row | null = null,
    private filters: Array<{ field: string; value: unknown; op: "eq" }> = [],
  ) {}

  select() {
    return this;
  }

  update(payload: Row) {
    this.payload = payload;
    return new Query(this.state, this.table, "update", this.payload, this.filters);
  }

  eq(field: string, value: unknown) {
    this.filters.push({ field, value, op: "eq" });
    return this;
  }

  maybeSingle<T>() {
    return this.resolve<T>();
  }

  private async resolve<T>(): Promise<{ data: T; error: null }> {
    const tableRows = this.state[this.table];

    if (this.mode === "update") {
      for (let i = 0; i < tableRows.length; i += 1) {
        if (this.matches(tableRows[i])) {
          tableRows[i] = { ...tableRows[i], ...(this.payload ?? {}) };
        }
      }
    }

    const rows = this.state[this.table].filter((row) => this.matches(row));
    return { data: (rows[0] ?? null) as T, error: null };
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => {
      if (filter.op === "eq") {
        return row[filter.field] === filter.value;
      }

      return false;
    });
  }
}

function createFakeClient(state: DbState) {
  return {
    from(table: keyof DbState) {
      return new Query(state, table);
    },
  };
}

function loadPatchHandler() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";

  const routePath = require.resolve("../app/api/actors/route");
  const storePath = require.resolve("../lib/data/persistence-store");
  delete require.cache[routePath];
  delete require.cache[storePath];

  return require("../app/api/actors/route") as typeof import("../app/api/actors/route");
}

test("PATCH /api/actors updates the actor purpose", async () => {
  const state: DbState = {
    actors: [
      {
        id: "actor-1",
        name: "Writer",
        system_prompt: "Original prompt",
        parent_actor_id: null,
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    ],
    chats: [],
    messages: [],
    short_term_memory: [],
    intermediate_memory: [],
    long_term_memory: [],
  };

  (globalThis as { __KATIE_SUPABASE_ADMIN_CLIENT__?: ReturnType<typeof createFakeClient> }).__KATIE_SUPABASE_ADMIN_CLIENT__ =
    createFakeClient(state);
  const { PATCH } = loadPatchHandler();

  const request = new NextRequest("http://localhost/api/actors?id=actor-1", {
    method: "PATCH",
    body: JSON.stringify({ purpose: "Updated system prompt" }),
    headers: { "content-type": "application/json" },
  });

  const response = await PATCH(request);
  const payload = (await response.json()) as { actor?: { id: string; purpose: string } };

  assert.equal(response.status, 200);
  assert.equal(payload.actor?.id, "actor-1");
  assert.equal(payload.actor?.purpose, "Updated system prompt");
  assert.equal(state.actors[0].system_prompt, "Updated system prompt");
});
