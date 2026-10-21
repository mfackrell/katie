import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;

type DbState = {
  actors: Row[];
  managed_agents: Row[];
  chats: Row[];
  messages: Row[];
  short_term_memory: Row[];
  intermediate_memory: Row[];
  long_term_memory: Row[];
  actor_long_term_memory?: Row[];
  actor_memory_calibration_backups?: Row[];
};

class Query {
  constructor(
    private readonly state: DbState,
    private readonly table: keyof DbState,
    private readonly mode: "select" | "update" | "insert" = "select",
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

  insert(payload: Row) {
    return new Query(this.state, this.table, "insert", payload, this.filters);
  }

  upsert(payload: Row) {
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

  single<T>() {
    return this.resolve<T>();
  }

  then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) {
    return this.resolve().then(resolve, reject);
  }

  private async resolve<T>(): Promise<{ data: T; error: null }> {
    const tableRows = (this.state[this.table] ??= []);

    if (this.mode === "insert") {
      tableRows.push({ ...(this.payload ?? {}) });
    }
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
  const profilePath = require.resolve("../lib/router/actor-routing-profile");
  delete require.cache[routePath];
  delete require.cache[storePath];
  delete require.cache[profilePath];

  return require("../app/api/actors/route") as typeof import("../app/api/actors/route");
}

test("PATCH /api/actors updates the actor purpose", async () => {
  const state: DbState = { managed_agents: [],
    actors: [
      {
        id: "actor-1",
        name: "Writer",
        system_prompt: "Original prompt",
        routing_profile: null,
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


test("review-only PATCH persists mode without changing prompt or routing; invalid modes are rejected", async () => {
  const state: DbState = { managed_agents: [], actors: [{ id: "actor-mode", name: "Writer", system_prompt: "Keep prompt", routing_profile: { preserved: true }, review_mode: "adaptive", parent_actor_id: null }], chats: [], messages: [], short_term_memory: [], intermediate_memory: [], long_term_memory: [] };
  (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__ = createFakeClient(state);
  const { PATCH } = loadPatchHandler();
  const patch = (reviewMode: string) => PATCH(new NextRequest("http://localhost/api/actors?id=actor-mode", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewMode }) }));
  const response = await patch("always");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).actor.reviewMode, "always");
  assert.equal(state.actors[0].system_prompt, "Keep prompt");
  assert.deepEqual(state.actors[0].routing_profile, { preserved: true });
  assert.equal((await patch("typo")).status, 400);
  assert.equal(state.actors[0].review_mode, "always");
  assert.equal((await patch("off")).status, 200);
  assert.equal(state.actors[0].review_mode, "off");
});


test("memory calibration merges only signed approved duplicates, preserving all facts and restoration backup", async()=>{
 const actorId="ab234567-1234-4321-8765-123456789abc";
 const original={version:3,purpose:"Actor memory",entries:[
   {key:"a",value:"Original project recovery fact",source:"user-stated",evidenceMessageIds:["m1"]},
   {key:"b",value:"Complementary project recovery detail",source:"user-stated",evidenceMessageIds:["m2"]},
   {key:"c",value:"Unrelated useful work experience",source:"user-stated"}
 ]};
 const state:DbState={actors:[{id:actorId,name:"Advisor",system_prompt:"Executive project applications",parent_actor_id:null,routing_profile:null,created_at:"x",updated_at:"x"}],managed_agents:[],chats:[],messages:[],short_term_memory:[],intermediate_memory:[],long_term_memory:[],actor_long_term_memory:[{actor_id:actorId,revision:5,content:original}],actor_memory_calibration_backups:[]};
 (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__=createFakeClient(state);
 process.env.OPENAI_API_KEY="test-only-signing-key";
 const {PATCH}=loadPatchHandler();
 const {createHash,createHmac}=require("node:crypto") as typeof import("node:crypto");
 const hash=createHash("sha256").update(JSON.stringify(original)).digest("hex");
 const group={type:"redundancy",keys:["a","b"],reason:"Overlapping statements"};
 const groups=[group];
 const proof=createHmac("sha256",process.env.OPENAI_API_KEY).update(JSON.stringify({actorId,hash,groups})).digest("hex");
 const body={calibration:"apply",hash,proof,groups,approved:groups};
 const response=await PATCH(new NextRequest("http://localhost/api/actors?id="+actorId,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(body)}));
 assert.equal(response.status,200,JSON.stringify(await response.json()));
 const saved=(state.actor_long_term_memory![0].content as typeof original).entries;
 assert.equal(saved.length,2);
 assert.ok(saved.find(e=>e.key==="a")?.value.includes("Original project recovery fact"));
 assert.ok(saved.find(e=>e.key==="a")?.value.includes("Complementary project recovery detail"));
 assert.ok(saved.find(e=>e.key==="c"));
 assert.equal(state.actor_memory_calibration_backups?.length,1);
 assert.deepEqual(state.actor_memory_calibration_backups?.[0].memory_content,original);
});

test("calibration cannot apply unsigned or stale proposals",async()=>{
 const actorId="ab234567-1234-4321-8765-123456789abc";
 const original={version:3,purpose:"Memory",entries:[{key:"a",value:"Keep this important fact"},{key:"b",value:"Keep a second fact"}]};
 const state:DbState={actors:[{id:actorId,name:"Advisor",system_prompt:"Applications",parent_actor_id:null,routing_profile:null,created_at:"x",updated_at:"x"}],managed_agents:[],chats:[],messages:[],short_term_memory:[],intermediate_memory:[],long_term_memory:[],actor_long_term_memory:[{actor_id:actorId,revision:2,content:original}],actor_memory_calibration_backups:[]};
 (globalThis as any).__KATIE_SUPABASE_ADMIN_CLIENT__=createFakeClient(state);
 process.env.OPENAI_API_KEY="test-only-signing-key";
 const {PATCH}=loadPatchHandler();
 const {createHash,createHmac}=require("node:crypto") as typeof import("node:crypto");
 const hash=createHash("sha256").update(JSON.stringify(original)).digest("hex");
 const approved=[{type:"irrelevant",keys:["a"],reason:"test"}];
 const invalid=await PATCH(new NextRequest("http://localhost/api/actors?id="+actorId,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({calibration:"apply",hash,proof:"0".repeat(64),groups:approved,approved})}));
 assert.equal(invalid.status,409);
 const proof=createHmac("sha256",process.env.OPENAI_API_KEY).update(JSON.stringify({actorId,hash,groups:approved})).digest("hex");
 const invalidHash="f".repeat(64);
 const stale=await PATCH(new NextRequest("http://localhost/api/actors?id="+actorId,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({calibration:"apply",hash:invalidHash,proof,groups:approved,approved})}));
 assert.equal(stale.status,409);
 assert.equal((state.actor_long_term_memory![0].content as typeof original).entries.length,2);
 assert.equal(state.actor_memory_calibration_backups?.length,0);
});
