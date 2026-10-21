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
    },
    async rpc(name: string, args: { p_actor_id: string; p_entries: Row[] }) {
      assert.equal(name, "merge_actor_long_term_memory_entries");
      let row = state.actor_long_term_memory.find(item => item.actor_id === args.p_actor_id);
      if (!row) {
        row = { actor_id: args.p_actor_id, content: { version: 3, purpose: "Actor-wide durable memory", entries: [] } };
        state.actor_long_term_memory.push(row);
      }
      const current = row.content as { version: number; purpose: string; entries: Row[] };
      const entries = [...current.entries];
      for (const patch of args.p_entries) {
        const index = entries.findIndex(item => item.key === patch.key);
        if (index < 0) entries.push(patch);
        else entries[index] = patch;
      }
      row.content = { ...current, entries };
      return { data: row.content, error: null };
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
function learned(key: string, value: string, quote: string, messageId = "m1") {
  return { ...fact(key, value), category: "pattern", evidenceMessageIds: [messageId],
    evidenceQuotes: [{ messageId, quote }] };
}

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

test("explicit document chunking covers every character", async () => {
  const { splitExplicitMemoryDocument } = require("../lib/memory/explicit-fact-extractor") as typeof import("../lib/memory/explicit-fact-extractor");
  const source = Array.from({ length: 60 }, (_, i) => `# Section ${i}\n${"word ".repeat(180)}\n`).join("");
  const chunks = splitExplicitMemoryDocument(source);
  assert.ok(chunks.length > 2);
  assert.equal(chunks.join(""), source);
  assert.ok(chunks.every((chunk) => chunk.length <= 8500));
});

test("explicit extraction saves quote-grounded structured facts across new chats", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  (globalThis as any).__KATIE_EXPLICIT_FACT_OPENAI_CLIENT__ = {
    chat: { completions: { async create() {
      return { choices: [{ message: { content: JSON.stringify({ facts: [
        { key: "experience.years", category: "fact", value: "Twenty-five years in finance and accounting.", evidence: "25 years in finance and accounting" },
        { key: "engagement.revenue", category: "fact", value: "Revenue was $90M rather than $200M.", evidence: "Revenue was $90M, not $200M" },
        { key: "fabricated", category: "fact", value: "The user went to Mars.", evidence: "flew to Mars" }
      ] }) } }] };
    } } }
  };
  clearModule("../lib/data/persistence-store");
  clearModule("../lib/memory/explicit-fact-extractor");
  const store = require("../lib/data/persistence-store") as typeof import("../lib/data/persistence-store");
  const extractor = require("../lib/memory/explicit-fact-extractor") as typeof import("../lib/memory/explicit-fact-extractor");
  await store.saveActor({ id: "a1", name: "Actor", purpose: "Prompt" });
  await store.saveChat({ id: "c1", actorId: "a1", title: "Old", createdAt: "x", updatedAt: "x" });
  await store.saveChat({ id: "c2", actorId: "a1", title: "New", createdAt: "x", updatedAt: "x" });
  const message = "25 years in finance and accounting. Revenue was $90M, not $200M.";
  const result = await extractor.extractAndSaveExplicitFacts("a1", "c1", "m123", message);
  assert.equal(result.factsSaved, 2);
  assert.equal(result.chunksFailed, 0);
  const memory = await store.getLongTermMemory("a1", "c2");
  const facts = (memory.entries as Array<{ key: string; evidenceMessageIds: string[] }>);
  assert.equal(facts.length, 2);
  assert.ok(facts.every((entry) => entry.key.startsWith("reference.m123.")));
  assert.ok(facts.every((entry) => entry.evidenceMessageIds[0] === "m123"));
});

test("explicit extraction reports no_change and unsupported facts as failures, not success", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  (globalThis as any).__KATIE_EXPLICIT_FACT_OPENAI_CLIENT__ = createMockMemoryEditorClient(
    JSON.stringify({ action: "no_change" })
  );
  clearModule("../lib/data/persistence-store");
  clearModule("../lib/memory/explicit-fact-extractor");
  const store = require("../lib/data/persistence-store") as typeof import("../lib/data/persistence-store");
  const extractor = require("../lib/memory/explicit-fact-extractor") as typeof import("../lib/memory/explicit-fact-extractor");
  await store.saveActor({ id: "a1", name: "Actor", purpose: "Prompt" });
  await store.saveChat({ id: "c1", actorId: "a1", title: "Old", createdAt: "x", updatedAt: "x" });
  const source = "The user worked in executive finance for 25 years.";
  const result = await extractor.extractAndSaveExplicitFacts("a1", "c1", "m456", source);
  assert.equal(result.factsSaved, 0);
  assert.equal(result.chunksFailed, 1);
  assert.deepEqual(await store.getLongTermMemory("a1", "c1"), {});
});

test("automatic editor preserves fact extraction entries when model omits them", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__ = createMockMemoryEditorClient(JSON.stringify({
    action: "replace", updatedContent: memory(learned("new.fact", "The user prefers executive synthesis over role catalogs.", "Please emphasize executive synthesis instead of listing individual roles."))
  }));
  const { store, memoryEditor } = loadModules();
  await store.saveActor({ id: "a1", name: "Actor", purpose: "Prompt" });
  await store.saveChat({ id: "c1", actorId: "a1", title: "Chat", createdAt: "x", updatedAt: "x" });
  await store.setLongTermMemory("a1", "c1", memory(fact("reference.m1.0.career", "User currently manages finance operations.")));
  await store.saveMessage("c1", { id: "m1", role: "user", content: "Please emphasize executive synthesis instead of listing individual roles." });
  await memoryEditor.maybeUpdateLongTermMemory("a1", "c1", "Please emphasize executive synthesis instead of listing individual roles.");
  const current = await store.getLongTermMemory("a1", "c1");
  assert.equal((current.entries as Array<{ key: string }>).length, 2);
});

test("a clarification persists authoritatively across chats even if normal editor says no_change", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__ =
    createMockMemoryEditorClient(JSON.stringify({ action: "no_change" }));
  clearModule("../lib/data/persistence-store");
  clearModule("../lib/memory/explicit-memory");
  clearModule("../lib/memory/assemble-context");
  const store = require("../lib/data/persistence-store") as typeof import("../lib/data/persistence-store");
  const explicit = require("../lib/memory/explicit-memory") as typeof import("../lib/memory/explicit-memory");
  const context = require("../lib/memory/assemble-context") as typeof import("../lib/memory/assemble-context");

  const correction = [
    "we need to clarify one point in your long term memory. re the global PE backed professional services engagement:",
    "Mark led the accounting recovery through his team.",
    "He personally performed relatively little underlying transaction-level accounting work.",
    "The team restored the monthly close and completed the audit in ten weeks."
  ].join("\n");

  await store.saveActor({ id: "a1", name: "Actor", purpose: "Executive strategist" });
  await store.saveChat({ id: "c1", actorId: "a1", title: "Old", createdAt: "x", updatedAt: "x" });
  await store.saveChat({ id: "c2", actorId: "a1", title: "New", createdAt: "x", updatedAt: "x" });
  await store.setLongTermMemory("a1", "c1", memory(fact("reference.old.0", "Personally completed the ledger reconciliations.")));
  await store.saveMessage("c1", { id: "m999", role: "user", content: correction });
  // The in-memory Supabase test double has no DB-generated UUID; pre-seed the
  // same source row so its upsert returns an existing document id.
  state.actor_memory_documents.push({
    id: "doc-correction", actor_id: "a1", source_message_id: "m999",
    title: "Pending correction", content: correction, created_at: "2026-10-10T19:00:00Z",
  });
  const result = await explicit.handleExplicitMemoryMutation("a1", "c1", "m999", correction);
  assert.match(result, /saved and verified/i);
  const durable = await store.getLongTermMemory("a1", "c2");
  const entries = durable.entries as Array<{key: string;value: string;evidenceMessageIds: string[]}>;
  assert.equal(entries.find(e => e.key === "correction.m999")?.value, correction);
  assert.deepEqual(entries.find(e => e.key === "correction.m999")?.evidenceMessageIds, ["m999"]);
  assert.equal(state.actor_memory_documents[0].content, correction);
  assert.equal(state.actor_memory_documents[0].title, "Authoritative correction to actor memory");

  const newChat = await context.assembleContext("a1", "c2");
  assert.ok(newChat.persona.includes("AUTHORITATIVE ACTOR MEMORY CORRECTIONS"));
  assert.ok(newChat.persona.includes(correction));
  assert.ok(newChat.persona.indexOf("AUTHORITATIVE ACTOR MEMORY CORRECTIONS") <
    newChat.persona.indexOf("LONG_TERM_MEMORY:"));
});

test("automatic memory editor cannot remove a previously verified correction", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__ = createMockMemoryEditorClient(JSON.stringify({
    action: "replace", updatedContent: memory(learned("misc", "The user values substantial evidence.", "Show me the substantive evidence behind your conclusions."))
  }));
  const { store, memoryEditor } = loadModules();
  await store.saveActor({ id: "a1", name: "Actor", purpose: "Prompt" });
  await store.saveChat({ id: "c1", actorId: "a1", title: "Chat", createdAt: "x", updatedAt: "x" });
  await store.setLongTermMemory("a1", "c1", memory(
    fact("correction.m1", "Clarification: Mark led the team rather than doing the accounting entries.")
  ));
  await store.saveMessage("c1", { id: "m1", role: "user", content: "Show me the substantive evidence behind your conclusions." });
  await memoryEditor.maybeUpdateLongTermMemory("a1", "c1", "Show me the substantive evidence behind your conclusions.");
  const current = await store.getLongTermMemory("a1", "c1");
  const entries = current.entries as Array<{key: string}>;
  assert.ok(entries.some(entry => entry.key === "correction.m1"));
  assert.ok(entries.some(entry => entry.key === "misc"));
});

test("automatic update preserves unrelated existing preferences, and downgrades inferred patterns", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  const quote = "I want executive-level synthesis instead of a resume of accounting duties.";
  (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__ = createMockMemoryEditorClient(JSON.stringify({
    action: "replace", updatedContent: memory(learned("preference.executive", "Use executive-level synthesis for applications.", quote))
  }));
  const {store,memoryEditor} = loadModules();
  await store.saveActor({id:"a1",name:"Actor",purpose:"Prompt"});
  await store.saveChat({id:"c1",actorId:"a1",title:"Chat",createdAt:"x",updatedAt:"x"});
  await store.setLongTermMemory("a1","c1",memory(fact("interaction.directness","User prefers direct plain communication.")));
  await store.saveMessage("c1",{id:"m1",role:"user",content:quote});
  await memoryEditor.maybeUpdateLongTermMemory("a1","c1",quote);
  const entries=(await store.getLongTermMemory("a1","c2")).entries as Array<Record<string,any>>;
  assert.equal(entries.length,2);
  assert.ok(entries.some(e=>e.key==="interaction.directness"));
  const learnedEntry=entries.find(e=>e.key==="preference.executive")!;
  assert.equal(learnedEntry.source,"assistant-inference");
  assert.equal(learnedEntry.confidence,"medium");
  assert.deepEqual(learnedEntry.evidenceMessageIds,["m1"]);
  assert.deepEqual(learnedEntry.evidenceQuotes,[{messageId:"m1",quote}]);
});

test("automatic memory ignores unsupported provenance even when cited user message exists", async () => {
  const state = makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  const quote="Your argument needs to explain why these experiences work together.";
  (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__ = createMockMemoryEditorClient(JSON.stringify({
    action:"replace",updatedContent:memory(learned("bad.pattern","User values integrated reasoning.",quote,"m1"))
  }));
  const {store,memoryEditor}=loadModules();
  await store.saveActor({id:"a1",name:"Actor",purpose:"Prompt"});
  await store.saveChat({id:"c1",actorId:"a1",title:"Chat",createdAt:"x",updatedAt:"x"});
  await store.setLongTermMemory("a1","c1",memory(fact("existing","Keep me.")));
  await store.saveMessage("c1",{id:"m1",role:"user",content:"Interim CFO for Global Industrial Client and audit remediation."});
  await store.saveMessage("c1",{id:"m2",role:"assistant",content:"Initial draft."});
  await store.saveMessage("c1",{id:"m3",role:"user",content:quote});
  await store.saveMessage("c1",{id:"m4",role:"assistant",content:"Acknowledged."});
  await memoryEditor.maybeUpdateLongTermMemory("a1","c1",quote);
  const entries=(await store.getLongTermMemory("a1","c1")).entries as Array<{key:string}>;
  assert.deepEqual(entries.map(e=>e.key),["existing"]);
});

test("concurrent updates from different chats merge without losing entries", async () => {
  const state=makeState();
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__=createFakeClient(state);
  const {store}=loadModules();
  await store.saveActor({id:"a1",name:"Actor",purpose:"Prompt"});
  await Promise.all([
    store.mergeActorLongTermMemoryEntries("a1",[fact("from.chat.one","First durable lesson.")]),
    store.mergeActorLongTermMemoryEntries("a1",[fact("from.chat.two","Second durable lesson.")]),
  ]);
  const result=await store.getLongTermMemory("a1","any");
  const keys=(result.entries as Array<{key:string}>).map(e=>e.key).sort();
  assert.deepEqual(keys,["from.chat.one","from.chat.two"]);
});

test("automatic actor-purpose learning persists firsthand facts with quoted evidence", async () => {
 const state=makeState();
 (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__=createFakeClient(state);
 const quote="At our installation company I updated WIP every month.";
 let observedPrompt="";
 (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__={chat:{completions:{async create(p:any){
   observedPrompt=p.messages.map((m:any)=>m.content).join("\\n");
   return {choices:[{message:{content:JSON.stringify({action:"replace",updatedContent:{
     version:3,purpose:"Actor memory",entries:[{key:"experience.wip",category:"fact",value:"User updated WIP monthly for installation projects.",source:"user-stated",confidence:"high",evidenceMessageIds:["m1"],evidenceQuotes:[{messageId:"m1",quote}]}]}})}}]};
 }}}};
 const {store,memoryEditor}=loadModules();
 await store.saveActor({id:"a1",name:"Advisor",purpose:"Help with executive project applications."});
 await store.saveChat({id:"c1",actorId:"a1",title:"Old",createdAt:"x",updatedAt:"x"});
 await store.saveChat({id:"c2",actorId:"a1",title:"New",createdAt:"x",updatedAt:"x"});
 await store.saveMessage("c1",{id:"m1",role:"user",content:quote});
 await memoryEditor.maybeUpdateLongTermMemory("a1","c1",quote);
 const retained=await store.getLongTermMemory("a1","c2");
 assert.equal((retained.entries as any[])[0].source,"user-stated");
 assert.match(observedPrompt,/Help with executive project applications/);
 assert.equal((retained.entries as any[])[0].evidenceQuotes[0].messageId,"m1");
});

test("automatic memory accepts valid unwrapped version-3 model output with firsthand provenance", async () => {
 const state=makeState();
 (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__=createFakeClient(state);
 const quote="I brought in full-time AR and AP managers when the accounting team had departed.";
 (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__=createMockMemoryEditorClient(JSON.stringify({
  version:3,purpose:"Actor memory",entries:[{
   key:"career.accounting.team.recovery",category:"fact",
   value:"User hired full-time AR and AP managers after most of the accounting function departed.",
   source:"user-stated",confidence:"high",evidenceMessageIds:["m1"],
   evidenceQuotes:[{messageId:"m1",quote}]
  }]
 }));
 const {store,memoryEditor}=loadModules();
 await store.saveActor({id:"a1",name:"Application Specialist",purpose:"Craft compelling project applications."});
 await store.saveChat({id:"c1",actorId:"a1",title:"Current",createdAt:"x",updatedAt:"x"});
 await store.saveChat({id:"c2",actorId:"a1",title:"Later",createdAt:"x",updatedAt:"x"});
 await store.saveMessage("c1",{id:"m1",role:"user",content:quote});
 await memoryEditor.maybeUpdateLongTermMemory("a1","c1",quote);
 const entries=(await store.getLongTermMemory("a1","c2")).entries as any[];
 assert.equal(entries.length,1);
 assert.equal(entries[0].source,"user-stated");
 assert.equal(entries[0].evidenceMessageIds[0],"m1");
});
test("unwrapped memory without matching user evidence is not saved", async () => {
 const state=makeState();
 (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__=createFakeClient(state);
 (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__=createMockMemoryEditorClient(JSON.stringify({
  version:3,purpose:"Actor memory",entries:[{
   key:"unsupported",category:"fact",value:"An invented claim.",
   source:"user-stated",confidence:"high",evidenceMessageIds:["m1"],
   evidenceQuotes:[{messageId:"m1",quote:"The user did something that they never actually said."}]
  }]
 }));
 const {store,memoryEditor}=loadModules();
 await store.saveActor({id:"a1",name:"Application Specialist",purpose:"Write applications."});
 await store.saveChat({id:"c1",actorId:"a1",title:"Current",createdAt:"x",updatedAt:"x"});
 await store.saveMessage("c1",{id:"m1",role:"user",content:"A different statement about work."});
 await memoryEditor.maybeUpdateLongTermMemory("a1","c1","A different statement about work.");
 assert.equal((await store.getLongTermMemory("a1","c1")).entries,undefined);
});

test("automatic memory repair satisfies provider JSON mode and saves only repaired source-verified facts", async () => {
 const state=makeState();
 (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__=createFakeClient(state);
 const quote="I reconciled project costs to the general ledger every month.";
 const entry={key:"career.project.cost.reconciliation",category:"fact",value:quote,
   source:"user-stated",confidence:"high",evidenceMessageIds:["m1"]};
 let calls=0;
 (globalThis as any).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__={chat:{completions:{async create(params:any){
   calls++;
   const prompt=params.messages.map((message:any)=>message.content).join("\n");
   // Reproduce the provider's admission rule, rather than allowing every mock
   // request through regardless of the production response_format contract.
   if(params.response_format?.type === "json_object" && !/json/i.test(prompt)) {
     throw new Error("400 'messages' must contain the word 'json' when response_format is json_object");
   }
   return {choices:[{message:{content:JSON.stringify({action:"replace",updatedContent:{
     version:3,purpose:"Durable career knowledge",entries:[{...entry,
       evidenceQuotes:[{messageId:"m1",quote:calls===1?"A source quote that was never provided.":quote}]}]
   }})}}]};
 }}}};
 const {store,memoryEditor}=loadModules();
 await store.saveActor({id:"a1",name:"Advisor",purpose:"Prepare relevant professional examples."});
 await store.saveChat({id:"c1",actorId:"a1",title:"Current",createdAt:"x",updatedAt:"x"});
 await store.setLongTermMemory("a1","c1",memory(fact("existing","Existing durable experience.")));
 await store.saveMessage("c1",{id:"m1",role:"user",content:quote});
 await memoryEditor.maybeUpdateLongTermMemory("a1","c1",quote);
 assert.equal(calls,2,"Invalid initial evidence must enter the repair path");
 const entries=(await store.getLongTermMemory("a1","other-chat")).entries as any[];
 assert.equal(entries.length,2,"Repair preserves unrelated durable knowledge");
 const saved=entries.find(value=>value.key===entry.key);
 assert.equal(saved?.value,quote);
 assert.deepEqual(saved?.evidenceQuotes,[{messageId:"m1",quote}]);
});
