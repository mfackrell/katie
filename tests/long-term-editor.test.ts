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
    private rowLimit: number | null = null
  ) {}

  select() {
    return this;
  }

  returns<T>() {
    return this as unknown as Promise<{ data: T; error: null }>;
  }

  order(field: string, opts: { ascending: boolean }) {
    this.sort = { field, ascending: opts.ascending };
    return this;
  }

  limit(value: number) {
    this.rowLimit = value;
    return this;
  }

  eq(field: string, value: unknown) {
    this.filters.push({ field, value, op: "eq" });
    return this;
  }

  in(field: string, values: unknown[]) {
    this.filters.push({ field, value: values, op: "in" });
    return this;
  }

  upsert(payload: Row | Row[]) {
    this.payload = payload;
    return this.exec("upsert");
  }

  insert(payload: Row | Row[]) {
    this.payload = payload;
    return this.exec("insert");
  }

  update(payload: Row) {
    this.payload = payload;
    return this.exec("update");
  }

  delete() {
    return this.exec("delete");
  }

  maybeSingle<T>() {
    return this.resolve<T>(true);
  }

  single<T>() {
    return this.resolve<T>(true);
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: any; error: null }) => TResult1 | PromiseLike<TResult1>) | null
  ): Promise<TResult1 | TResult2> {
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
          tableRows.push({
            ...row,
            created_at: row.created_at ?? "2026-03-24T00:00:00.000Z",
            updated_at: row.updated_at ?? "2026-03-24T00:00:00.000Z"
          });
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
    }
  };
}

function makeState(): DbState {
  return {
    actors: [],
    chats: [],
    messages: [],
    short_term_memory: [],
    intermediate_memory: [],
    long_term_memory: []
  };
}

function clearModule(modulePath: string): void {
  delete require.cache[require.resolve(modulePath)];
}

function loadModules() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";

  clearModule("../lib/data/persistence-store");
  clearModule("../lib/memory/long-term-editor");

  const store = require("../lib/data/persistence-store") as typeof import("../lib/data/persistence-store");
  const memoryEditor = require("../lib/memory/long-term-editor") as typeof import("../lib/memory/long-term-editor");

  return { store, memoryEditor };
}

function createMockMemoryEditorClient(responseContent: string) {
  return {
    chat: {
      completions: {
        async create() {
          return {
            choices: [
              {
                message: {
                  content: responseContent
                }
              }
            ]
          };
        }
      }
    }
  };
}

test("no-change result leaves long_term_memory untouched", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__ = createMockMemoryEditorClient(
    JSON.stringify({ action: "no_change" })
  );

  const { store, memoryEditor } = loadModules();

  await store.saveActor({ id: "a1", name: "Actor", purpose: "Prompt" });
  await store.saveChat({ id: "c1", actorId: "a1", title: "Chat", createdAt: "x", updatedAt: "x" });
  await store.setLongTermMemory("a1", "c1", { profile: { timezone: "UTC" } });
  await store.saveMessage("c1", { id: "m1", role: "user", content: "hello" });

  await memoryEditor.maybeUpdateLongTermMemory("a1", "c1", "hello");

  const saved = await store.getLongTermMemory("a1", "c1");
  assert.deepEqual(saved, { profile: { timezone: "UTC" } });
});

test("replace result writes revised content to long_term_memory", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__ = createMockMemoryEditorClient(
    JSON.stringify({ action: "replace", updatedContent: { profile: { timezone: "PST", language: "en" } } })
  );

  const { store, memoryEditor } = loadModules();

  await store.saveActor({ id: "a1", name: "Actor", purpose: "Prompt" });
  await store.saveChat({ id: "c1", actorId: "a1", title: "Chat", createdAt: "x", updatedAt: "x" });
  await store.setLongTermMemory("a1", "c1", { profile: { timezone: "UTC" } });
  await store.saveMessage("c1", { id: "m1", role: "user", content: "I'm in Pacific time now" });

  await memoryEditor.maybeUpdateLongTermMemory("a1", "c1", "I'm in Pacific time now");

  const saved = await store.getLongTermMemory("a1", "c1");
  assert.deepEqual(saved, { profile: { timezone: "PST", language: "en" } });
});

test("empty existing memory can be populated", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__ = createMockMemoryEditorClient(
    JSON.stringify({ action: "replace", updatedContent: { preferences: { editorTheme: "dark" } } })
  );

  const { store, memoryEditor } = loadModules();

  await store.saveActor({ id: "a1", name: "Actor", purpose: "Prompt" });
  await store.saveChat({ id: "c1", actorId: "a1", title: "Chat", createdAt: "x", updatedAt: "x" });
  await store.saveMessage("c1", { id: "m1", role: "user", content: "Please remember I prefer dark mode." });

  assert.deepEqual(await store.getLongTermMemory("a1", "c1"), {});

  await memoryEditor.maybeUpdateLongTermMemory("a1", "c1", "Please remember I prefer dark mode.");

  const saved = await store.getLongTermMemory("a1", "c1");
  assert.deepEqual(saved, { preferences: { editorTheme: "dark" } });
});

test("remove/forget behavior results in revised saved content", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__ = createMockMemoryEditorClient(
    JSON.stringify({ action: "replace", updatedContent: { profile: { timezone: "UTC" } } })
  );

  const { store, memoryEditor } = loadModules();

  await store.saveActor({ id: "a1", name: "Actor", purpose: "Prompt" });
  await store.saveChat({ id: "c1", actorId: "a1", title: "Chat", createdAt: "x", updatedAt: "x" });
  await store.setLongTermMemory("a1", "c1", {
    profile: { timezone: "UTC", favoriteColor: "blue" },
    preferences: { newsletter: true }
  });
  await store.saveMessage("c1", { id: "m1", role: "user", content: "Forget my favorite color." });

  await memoryEditor.maybeUpdateLongTermMemory("a1", "c1", "Forget my favorite color.");

  const saved = await store.getLongTermMemory("a1", "c1");
  assert.deepEqual(saved, { profile: { timezone: "UTC" } });
});

test("failure in memory-editor path does not throw", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__ = {
    chat: {
      completions: {
        async create() {
          throw new Error("memory editor failed");
        }
      }
    }
  };

  const { store, memoryEditor } = loadModules();

  await store.saveActor({ id: "a1", name: "Actor", purpose: "Prompt" });
  await store.saveChat({ id: "c1", actorId: "a1", title: "Chat", createdAt: "x", updatedAt: "x" });
  await store.setLongTermMemory("a1", "c1", { profile: { timezone: "UTC" } });
  await store.saveMessage("c1", { id: "m1", role: "user", content: "remember this" });

  await assert.doesNotReject(async () => {
    await memoryEditor.maybeUpdateLongTermMemory("a1", "c1", "remember this");
  });

  const saved = await store.getLongTermMemory("a1", "c1");
  assert.deepEqual(saved, { profile: { timezone: "UTC" } });
});


test("controlled memory update logs decision and persists revised memory", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__ = createMockMemoryEditorClient(
    JSON.stringify({ action: "replace", updatedContent: { preferences: { dislikes: ["seafood"] } } })
  );

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const { store, memoryEditor } = loadModules();

    await store.saveActor({ id: "a1", name: "Actor", purpose: "Prompt" });
    await store.saveChat({ id: "c1", actorId: "a1", title: "Chat", createdAt: "x", updatedAt: "x" });
    await store.saveMessage("c1", {
      id: "m1",
      role: "user",
      content: "I want you to remember that I do not like seafood."
    });

    const before = await store.getLongTermMemory("a1", "c1");
    assert.deepEqual(before, {});

    await memoryEditor.maybeUpdateLongTermMemory("a1", "c1", "I want you to remember that I do not like seafood.");

    const after = await store.getLongTermMemory("a1", "c1");
    assert.deepEqual(after, { preferences: { dislikes: ["seafood"] } });
    assert.ok(logs.some((entry) => entry.includes("[LongTermMemoryEditor] started")));
    assert.ok(logs.some((entry) => entry.includes("model returned replace")));
    assert.ok(logs.some((entry) => entry.includes("setLongTermMemory succeeded")));
  } finally {
    console.log = originalLog;
  }
});
