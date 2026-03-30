import test from "node:test";
import assert from "node:assert/strict";

type Row = Record<string, unknown>;

type DbState = {
  actors: Row[];
  chats: Row[];
  messages: Row[];
  persistent_directives: Row[];
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
    private filters: Array<{ field: string; value: unknown; op: "eq" | "in" }> = []
  ) {}

  select() { return this; }
  order() { return this; }
  eq(field: string, value: unknown) { this.filters.push({ field, value, op: "eq" }); return this; }
  in(field: string, value: unknown[]) { this.filters.push({ field, value, op: "in" }); return this; }
  upsert(payload: Row | Row[]) { this.payload = payload; return this.exec("upsert"); }
  update(payload: Row) { this.payload = payload; return this.exec("update"); }
  delete() { return this.exec("delete"); }
  maybeSingle<T>() { return this.resolve<T>(true); }
  single<T>() { return this.resolve<T>(true); }
  returns<T>() { return this as unknown as Promise<{ data: T; error: null }>; }

  then<TResult1 = unknown>(onfulfilled?: ((value: { data: any; error: null }) => TResult1 | PromiseLike<TResult1>) | null) {
    return this.resolve<any>(false).then(onfulfilled as any);
  }

  private exec(mode: "upsert" | "update" | "delete") {
    return new Query(this.state, this.table, mode, this.payload, this.filters);
  }

  private async resolve<T>(single: boolean): Promise<{ data: T; error: null }> {
    const rows = this.state[this.table];
    if (this.mode === "upsert") {
      const payloadRows = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      for (const payload of payloadRows) {
        const idx = rows.findIndex((row) => row.id === payload.id);
        if (idx >= 0) rows[idx] = { ...rows[idx], ...payload };
        else rows.push({ ...payload });
      }
    }

    if (this.mode === "update") {
      for (let i = 0; i < rows.length; i += 1) {
        if (this.matches(rows[i])) rows[i] = { ...rows[i], ...(this.payload as Row) };
      }
    }

    if (this.mode === "delete") {
      this.state[this.table] = rows.filter((row) => !this.matches(row));
    }

    const resultRows = this.state[this.table].filter((row) => this.matches(row));
    return { data: (single ? resultRows[0] ?? null : resultRows) as T, error: null };
  }

  private matches(row: Row) {
    return this.filters.every((f) => (f.op === "eq" ? row[f.field] === f.value : (f.value as unknown[]).includes(row[f.field])));
  }
}

function createFakeClient(state: DbState) {
  return { from: (table: keyof DbState) => new Query(state, table) };
}

function makeState(): DbState {
  return { actors: [], chats: [], messages: [], persistent_directives: [], short_term_memory: [], intermediate_memory: [], long_term_memory: [] };
}

function loadStore() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  const modulePath = require.resolve("../lib/data/persistence-store");
  delete require.cache[modulePath];
  return require("../lib/data/persistence-store") as typeof import("../lib/data/persistence-store");
}

function loadService() {
  const modulePath = require.resolve("../lib/directives/service");
  delete require.cache[modulePath];
  return require("../lib/directives/service") as typeof import("../lib/directives/service");
}

test("directive add saves directive and syncs managed system prompt block", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  const store = loadStore();
  const service = loadService();

  await store.saveActor({ id: "a1", name: "Actor", purpose: "Base prompt." });

  const result = await service.processPersistentDirectiveMessage({
    actorId: "a1",
    userId: "u1",
    message: "I want you to remember that your favorite color is green",
    classify: async () => ({ action: "persistent_directive_add", directive: "Your favorite color is green.", confidence: 0.97 })
  });

  const actor = await store.getActorById("a1");
  assert.equal(result.handled, true);
  assert.equal(state.persistent_directives.length, 1);
  assert.match(actor?.purpose ?? "", /PERSISTENT DIRECTIVES — MANAGED BLOCK/);
  assert.match(actor?.purpose ?? "", /favorite color is green/i);
});

test("directive remove deactivates directives and removes managed block", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  const store = loadStore();
  const service = loadService();

  await store.saveActor({ id: "a1", name: "Actor", purpose: "Base prompt." });
  await store.saveDirective({ actorId: "a1", userId: "u1", directive: "Be blunt.", kind: "style", scope: "actor" });
  await store.syncActorSystemPromptWithDirectives("a1", "u1");

  const result = await service.processPersistentDirectiveMessage({
    actorId: "a1",
    userId: "u1",
    message: "Remove that instruction",
    classify: async () => ({ action: "persistent_directive_remove", directive: null, confidence: 0.95 })
  });

  const actor = await store.getActorById("a1");
  assert.equal(result.handled, true);
  assert.equal(state.persistent_directives[0].active, false);
  assert.doesNotMatch(actor?.purpose ?? "", /PERSISTENT DIRECTIVES — MANAGED BLOCK/);
});

test("normal messages are not handled by directive flow", async () => {
  const service = loadService();

  const result = await service.processPersistentDirectiveMessage({
    actorId: "a1",
    userId: "u1",
    message: "How do I deploy this app?",
    classify: async () => ({ action: "normal_message", confidence: 0.92 })
  });

  assert.equal(result.handled, false);
  assert.equal(result.action, "normal_message");
});

test("fallback heuristic is used only when LLM classification fails", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  const store = loadStore();
  const service = loadService();
  await store.saveActor({ id: "a1", name: "Actor", purpose: "Base prompt." });

  let fallbackCalled = false;
  const result = await service.processPersistentDirectiveMessage({
    actorId: "a1",
    userId: "u1",
    message: "Remember that I prefer concise answers.",
    classify: async () => null,
    fallbackClassify: () => {
      fallbackCalled = true;
      return { action: "persistent_directive_add", directive: "I prefer concise answers.", confidence: null };
    }
  });

  assert.equal(fallbackCalled, true);
  assert.equal(result.usedFallback, true);
  assert.equal(result.handled, true);
});
