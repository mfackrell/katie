import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
const native = createRequire(import.meta.url);
function modules(overrides = {}) {
  const cache = new Map();
  const load = (name) => {
    if (name in overrides) return overrides[name];
    if (!name.startsWith("@/") && !name.startsWith("/")) return native(name);
    let path = name.startsWith("@/") ? resolve(name.slice(2)) : name;
    if (!path.endsWith(".ts"))
      path = existsSync(path + ".ts")
        ? path + ".ts"
        : resolve(path, "index.ts");
    if (cache.has(path)) return cache.get(path);
    const exports = {};
    cache.set(path, exports);
    vm.runInNewContext(
      ts.transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText,
      {
        exports,
        require: (n) =>
          n.startsWith(".") ? load(resolve(dirname(path), n)) : load(n),
        process,
        Buffer,
        Date,
        Set,
        Map,
        URL,
        URLSearchParams,
        console,
        Request,
        Response,
        Headers,
      },
    );
    return exports;
  };
  return load;
}
function database(tables, failedTable) {
  const calls = [];
  return {
    calls,
    rpc() {
      throw Error("Read view must never execute an RPC");
    },
    from(table) {
      const filters = [];
      let updates;
      const result = () => ({
        data: (tables[table] ?? []).filter((row) =>
          filters.every(([key, value]) => row[key] === value),
        ),
        error: table === failedTable ? { message: "Unavailable" } : null,
      });
      const q = {
        updateReturning(value) {
          calls.push({ table, updates: value });
          const output = result();
          if (!output.error) output.data.forEach(row => Object.assign(row, value));
          return Promise.resolve(output);
        },
        select() {
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return q;
        },
        eq(key, value) {
          filters.push([key, value]);
          return q;
        },
        in() {
          return q;
        },
        returns: async () => result(),
        maybeSingle: async () => {
          const output = result();
          const row = output.data[0] ?? null;
          if (row && updates && !output.error) Object.assign(row, updates);
          return { ...output, data: row };
        },
        then(resolve) {
          calls.push(table);
          return Promise.resolve(result()).then(resolve);
        },
      };
      return q;
    },
  };
}
test("work inventory excludes foreign chat records, groups coding tasks, and distinguishes delivery", async () => {
  const db = database({
    work_projects: [
      {
        id: "p",
        actor_id: "a",
        chat_id: "c",
        status: "running",
        phase: "development",
        spec: { name: "Website" },
      },
      {
        id: "foreign",
        actor_id: "other",
        chat_id: "foreign-chat",
        status: "completed",
        phase: "done",
      },
    ],
    agent_missions: [
      {
        id: "m",
        objective: "Implement website",
        status: "completed",
        project_id: "p",
        project_kind: "development",
        result: "Checked implementation",
      },
      {
        id: "foreign-m",
        objective: "Private foreign work",
        status: "completed",
      },
    ],
    agent_tasks: [
      {
        id: "job",
        actor_id: "a",
        chat_id: "c",
        status: "running",
        initial_input: "Coding attempt",
        snapshot: { name: "Developer" },
      },
    ],
    executive_delegations: [],
    mission_assignments: [
      { id: "job", mission_id: "m", role: "development", status: "running" },
      {
        id: "review",
        mission_id: "m",
        role: "review",
        job_key: "review",
        status: "completed",
        result: { verdict: "pass" },
      },
    ],
    messages: [],
  });
  const load = modules({
    "@/lib/data/supabase/admin": { getSupabaseAdminClient: () => db },
    "@/lib/data/persistence-store": {
      listChats: async () => [{ id: "c", actorId: "a" }],
    },
  });
  const response = await load("@/app/api/work/route").GET(),
    body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.items.length, 3);
  assert.equal(
    body.items.some((i) => i.title === "Private foreign work"),
    false,
  );
  assert.equal(
    body.items.find((i) => i.key === "task:job").parentKey,
    "mission:m",
  );
  assert.equal(
    body.items.find((i) => i.key === "mission:m").reviewState,
    "pass",
  );
  assert.equal(
    body.items.find((i) => i.key === "mission:m").deliveryState,
    "unknown",
  );
});

test("orchestrator removal retires only the owned version and preserves history", async () => {
  const id = "88888888-8888-4888-8888-888888888888";
  const entry = { id, actor_id: "a", status: "active", version: 2 };
  const db = database({ executive_orchestrators: [entry] });
  const load = modules({
    "@/lib/data/supabase/admin": { getSupabaseAdminClient: () => db },
    "@/lib/data/persistence-store": { listActors: async () => [{ id: "a" }] },
  });
  const route = load("@/app/api/specialists/route");
  assert.equal((await route.DELETE(new Request(`http://localhost/api/specialists?id=${id}&version=1`))).status, 409);
  assert.equal(db.calls.length, 0);
  const response = await route.DELETE(new Request(`http://localhost/api/specialists?id=${id}&version=2`));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).retainedHistory, true);
  assert.equal(entry.status, "retired");
  assert.equal(entry.version, 3);
  assert.equal(db.calls.length, 1);
  const foreign = modules({
    "@/lib/data/supabase/admin": { getSupabaseAdminClient: () => db },
    "@/lib/data/persistence-store": { listActors: async () => [{ id: "other" }] },
  })("@/app/api/specialists/route");
  assert.equal((await foreign.DELETE(new Request(`http://localhost/api/specialists?id=${id}&version=3`))).status, 404);
  assert.equal(db.calls.length, 1);
});
test("one unavailable source produces an explicit warning without erasing independent work", async () => {
  const db = database(
    {
      agent_tasks: [
        {
          id: "t",
          actor_id: "a",
          chat_id: "c",
          status: "draft",
          initial_input: "Saved task",
          snapshot: { name: "Analyst" },
        },
      ],
    },
    "agent_missions",
  );
  const load = modules({
    "@/lib/data/supabase/admin": { getSupabaseAdminClient: () => db },
    "@/lib/data/persistence-store": {
      listChats: async () => [{ id: "c", actorId: "a" }],
    },
  });
  const body = await (await load("@/app/api/work/route").GET()).json();
  assert.equal(body.items.length, 1);
  assert.match(body.warnings.join(" "), /Missions unavailable/);
});
test("workspace state rejects unknown conversations before issuing any write", async () => {
  const db = database({});
  const load = modules({
      "@/lib/data/supabase/admin": { getSupabaseAdminClient: () => db },
      "@/lib/data/persistence-store": {
        listActors: async () => [],
        listChats: async () => [],
      },
    }),
    route = load("@/app/api/ui-state/route");
  const request = new (native("next/server").NextRequest)(
    "http://localhost/api/ui-state",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "chat:11111111-1111-4111-8111-111111111111",
        version: 0,
        value: { draft: "Do not expose" },
      }),
    },
  );
  assert.equal((await route.PATCH(request)).status, 409);
  assert.equal(db.calls.length, 0);
});

test("projects retain their original requested outcome before a specification name exists", async () => {
  const db = database({
    work_projects: [
      {
        id: "draft-project",
        actor_id: "a",
        chat_id: "c",
        objective: "Build Take Eleven with explicit turn rules",
        status: "blocked",
        phase: "specification",
        spec: null,
      },
    ],
  });
  const load = modules({
    "@/lib/data/supabase/admin": { getSupabaseAdminClient: () => db },
    "@/lib/data/persistence-store": {
      listChats: async () => [{ id: "c", actorId: "a" }],
    },
  });
  const body = await (await load("@/app/api/work/route").GET()).json();
  assert.equal(
    body.items[0].title,
    "Build Take Eleven with explicit turn rules",
  );
});
