import test from "node:test";
import assert from "node:assert/strict";

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
    private readonly mode: "select" | "upsert" | "insert" | "update" | "delete" = "select",
    private payload: Row | Row[] | null = null,
    private filters: Array<{ field: string; value: unknown; op: "eq" | "in" }> = [],
    private sort: { field: string; ascending: boolean } | null = null,
    private rowLimit: number | null = null,
  ) {}

  select() { return this; }
  returns<T>() { return this as unknown as Promise<{ data: T; error: null }>; }
  order(field: string, opts: { ascending: boolean }) { this.sort = { field, ascending: opts.ascending }; return this; }
  limit(value: number) { this.rowLimit = value; return this; }
  eq(field: string, value: unknown) { this.filters.push({ field, value, op: "eq" }); return this; }
  in(field: string, values: unknown[]) { this.filters.push({ field, value: values, op: "in" }); return this; }

  upsert(payload: Row | Row[]) { this.payload = payload; return this.exec("upsert"); }
  insert(payload: Row | Row[]) { this.payload = payload; return this.exec("insert"); }
  update(payload: Row) { this.payload = payload; return this.exec("update"); }
  delete() { return this.exec("delete"); }

  maybeSingle<T>() { return this.resolve<T>(true); }
  single<T>() { return this.resolve<T>(true); }

  then<TResult1 = unknown, TResult2 = never>(onfulfilled?: ((value: { data: any; error: null }) => TResult1 | PromiseLike<TResult1>) | null): Promise<TResult1 | TResult2> {
    return this.resolve<any>(false).then(onfulfilled as any);
  }

  private exec(mode: "upsert" | "insert" | "update" | "delete") {
    return new Query(this.state, this.table, mode, this.payload, this.filters, this.sort, this.rowLimit);
  }

  private async resolve<T>(single: boolean): Promise<{ data: T; error: null }> {
    const tableRows = this.state[this.table];

    if (this.mode === "upsert" || this.mode === "insert") {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      for (const row of rows) {
        const id = row.id as string | undefined;
        const actorId = row.actor_id as string | undefined;
        const chatId = row.chat_id as string | undefined;
        const uniqueIdx = tableRows.findIndex((item) => {
          if (id && item.id === id) return true;
          if (actorId && chatId && item.actor_id === actorId && item.chat_id === chatId) return true;
          return false;
        });

        if (uniqueIdx >= 0) {
          tableRows[uniqueIdx] = { ...tableRows[uniqueIdx], ...row };
        } else {
          tableRows.push({ ...row, created_at: row.created_at ?? "2026-03-24T00:00:00.000Z", updated_at: row.updated_at ?? "2026-03-24T00:00:00.000Z" });
        }
      }
    }

    if (this.mode === "update") {
      for (let i = 0; i < tableRows.length; i += 1) {
        if (this.matches(tableRows[i])) {
          tableRows[i] = { ...tableRows[i], ...(this.payload as Row) };
        }
      }
    }

    if (this.mode === "delete") {
      const kept = tableRows.filter((row) => !this.matches(row));
      this.state[this.table] = kept;
    }

    let rows = this.state[this.table].filter((row) => this.matches(row));

    if (this.sort) {
      rows = [...rows].sort((a, b) => {
        const left = String(a[this.sort!.field] ?? "");
        const right = String(b[this.sort!.field] ?? "");
        const cmp = left.localeCompare(right);
        return this.sort!.ascending ? cmp : -cmp;
      });
    }

    if (this.rowLimit !== null) {
      rows = rows.slice(0, this.rowLimit);
    }

    const data = single ? (rows[0] ?? null) : rows;
    return { data: data as T, error: null };
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => {
      if (filter.op === "eq") {
        return row[filter.field] === filter.value;
      }
      const values = filter.value as unknown[];
      return values.includes(row[filter.field]);
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

function loadStore() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  const modulePath = require.resolve("../lib/data/blob-store");
  delete require.cache[modulePath];
  return require("../lib/data/blob-store") as typeof import("../lib/data/blob-store");
}

function makeState(): DbState {
  return {
    actors: [], chats: [], messages: [], short_term_memory: [], intermediate_memory: [], long_term_memory: [],
  };
}

test("creating actor/chat persists records plus memory rows", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  const store = loadStore();

  const actor = await store.saveActor({ id: "a1", name: "Actor", purpose: "Prompt" });
  const chat = await store.saveChat({ id: "c1", actorId: "a1", title: "Chat", createdAt: "x", updatedAt: "x" });

  assert.equal(actor.id, "a1");
  assert.equal(chat.id, "c1");
  assert.equal(state.actors.length, 1);
  assert.equal(state.chats.length, 1);
  assert.equal(state.short_term_memory.length, 1);
  assert.equal(state.intermediate_memory.length, 1);
  assert.equal(state.long_term_memory.length, 1);
});

test("list actors and chats return persisted supabase rows", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  const store = loadStore();

  await store.saveActor({ id: "a1", name: "Actor", purpose: "Prompt" });
  await store.saveChat({ id: "c1", actorId: "a1", title: "Chat", createdAt: "x", updatedAt: "x" });

  const actors = await store.listActors();
  const chats = await store.listChatsByActorId("a1");

  assert.deepEqual(actors.map((a) => a.id), ["a1"]);
  assert.deepEqual(chats.map((c) => c.id), ["c1"]);
});

test("saving message persists row and updates chat updated_at", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  const store = loadStore();

  await store.saveActor({ id: "a1", name: "Actor", purpose: "Prompt" });
  await store.saveChat({ id: "c1", actorId: "a1", title: "Chat", createdAt: "2026-03-24T00:00:00.000Z", updatedAt: "2026-03-24T00:00:00.000Z" });

  await store.saveMessage("c1", { id: "m1", role: "user", content: "hi" });

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].actor_id, "a1");
  assert.notEqual(state.chats[0].updated_at, "2026-03-24T00:00:00.000Z");
});

test("context state loads actor/messages/all memory from supabase", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  const store = loadStore();

  await store.saveActor({ id: "a1", name: "Actor", purpose: "Prompt" });
  await store.saveChat({ id: "c1", actorId: "a1", title: "Chat", createdAt: "x", updatedAt: "x" });
  await store.setShortTermMemory("a1", "c1", { working: true });
  await store.setIntermediateMemory("a1", "c1", { summary: "S" });
  await store.setLongTermMemory("a1", "c1", { durable: ["fact"] });
  await store.saveMessage("c1", { id: "m1", role: "user", content: "hello" });

  const context = await store.getChatContextState("a1", "c1");
  assert.equal(context.actor.id, "a1");
  assert.equal(context.recentMessages.length, 1);
  assert.equal(context.shortTermMemory.working, true);
  assert.equal(context.intermediateMemory.summary, "S");
  assert.deepEqual(context.longTermMemory.durable, ["fact"]);
});

test("chat context throws when actor or chat are missing", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  const store = loadStore();

  await assert.rejects(() => store.getChatContextState("missing", "chat"), /Actor not found/);
});
