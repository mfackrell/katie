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
  actor_long_term_memory: Row[];
  actor_memory_documents: Row[];
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
          if (this.table === "actor_long_term_memory" && actorId && item.actor_id === actorId) return true;
          if (this.table === "actor_memory_documents" && row.source_message_id && item.source_message_id === row.source_message_id) return true;
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
    long_term_memory: [], actor_long_term_memory: [], actor_memory_documents: []
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


function fact(key: string,value: string) {
 return {key,value,category:"fact",source:"user-stated",confidence:"high",evidenceMessageIds:["m1"]};
}
function memory(...entries: ReturnType<typeof fact>[]) {return {version:3,purpose:"Actor memory",entries};}
test("no change preserves memory", async()=>{
 const state=makeState();
 (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__=createFakeClient(state);
 (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__=createMockMemoryEditorClient(JSON.stringify({action:"no_change"}));
 const {store,memoryEditor}=loadModules();
 await store.saveActor({id:"a1",name:"Actor",purpose:"Prompt"});
 await store.saveChat({id:"c1",actorId:"a1",title:"Chat",createdAt:"x",updatedAt:"x"});
 await store.setLongTermMemory("a1","c1",memory(fact("f","old")));
 await store.saveMessage("c1",{id:"m1",role:"user",content:"hi"});
 await memoryEditor.maybeUpdateLongTermMemory("a1","c1","hi");
 assert.deepEqual(await store.getLongTermMemory("a1","other"),memory(fact("f","old")));
});
test("mandatory correction replaces wrong fact in all existing and future chats",async()=>{
 const state=makeState();
 (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__=createFakeClient(state);
 (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__=createMockMemoryEditorClient(
  JSON.stringify({action:"replace",updatedContent:memory(fact("revenue","Annual revenue $90M"))}));
 const {store,memoryEditor}=loadModules();
 await store.saveActor({id:"a1",name:"Actor",purpose:"Prompt"});
 await store.saveChat({id:"c1",actorId:"a1",title:"Chat",createdAt:"x",updatedAt:"x"});
 await store.saveChat({id:"c2",actorId:"a1",title:"New",createdAt:"x",updatedAt:"x"});
 await store.setLongTermMemory("a1","c1",memory(fact("revenue","Annual revenue $200M")));
 await store.saveMessage("c1",{id:"m1",role:"user",content:"Correct your long-term memory: annual revenue was $90M"});
 await memoryEditor.maybeUpdateLongTermMemory("a1","c1","Correct your long-term memory: annual revenue was $90M",{required:true});
 const result=await store.getLongTermMemory("a1","c2");
 assert.equal((result.entries as Array<{value:string}>)[0].value,"Annual revenue $90M");
});
test("mandatory correction fails rather than falsely claiming no_change",async()=>{
 const state=makeState();
 (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__=createFakeClient(state);
 (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__=createMockMemoryEditorClient(JSON.stringify({action:"no_change"}));
 const {store,memoryEditor}=loadModules();
 await store.saveActor({id:"a1",name:"Actor",purpose:"Prompt"});
 await store.saveChat({id:"c1",actorId:"a1",title:"Chat",createdAt:"x",updatedAt:"x"});
 await store.saveMessage("c1",{id:"m1",role:"user",content:"Correct your memory"});
 await assert.rejects(()=>memoryEditor.maybeUpdateLongTermMemory("a1","c1","Correct your memory",{required:true}),/declined/);
});
