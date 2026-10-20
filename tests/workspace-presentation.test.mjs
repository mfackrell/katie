import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
function load(path, dependencies = {}) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: (name) => {
      if (name in dependencies) return dependencies[name];
      throw Error(`Unexpected dependency ${name}`);
    },
  });
  return exports;
}
const model = load("lib/ui/work.ts");
const item = (source, id, extra = {}) => ({
  key: `${source}:${id}`,
  source,
  id,
  title: id,
  status: "running",
  phase: "analysis",
  updatedAt: "2026-10-20T15:00:00Z",
  chatId: "chat",
  specialist: "Operations",
  parentKey: null,
  isTest: false,
  result: null,
  reviewState: "unknown",
  deliveryState: "unknown",
  ...extra,
});
test("typed references keep colliding IDs distinct and nest project/mission/task once", () => {
  const rows = [
    item("project", "same"),
    item("mission", "same", { parentKey: "project:same" }),
    item("task", "task", { parentKey: "mission:same" }),
  ];
  const grouped = model.topLevelWork(rows);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].children[0].source, "mission");
  assert.equal(grouped[0].children[0].children[0].source, "task");
});
test("orphaned child remains discoverable without merging similar titles", () => {
  const rows = [
    item("mission", "a", { title: "Same title", parentKey: "project:missing" }),
    item("mission", "b", { title: "Same title" }),
  ];
  assert.equal(model.topLevelWork(rows).length, 2);
});
test("completion, review, and delivery are independent states", () => {
  assert.equal(
    model.workLabel(
      item("mission", "a", {
        status: "completed",
        reviewState: "pass",
        deliveryState: "pending",
      }),
    ),
    "Delivering result",
  );
  assert.equal(
    model.workLabel(
      item("mission", "a", {
        status: "completed",
        reviewState: "pass",
        deliveryState: "unknown",
      }),
    ),
    "Execution completed",
  );
  assert.equal(
    model.workLabel(
      item("mission", "a", { status: "completed", deliveryState: "delivered" }),
    ),
    "Result ready",
  );
  assert.equal(
    model.workLabel(item("task", "a", { status: "pr_ready" })),
    "Draft PR ready",
  );
});
test("managed workers never become default conversational personas", () => {
  assert.equal(
    model.actorAudience({ name: "Marketing", managedAgentId: "managed" }),
    "worker",
  );
  assert.equal(
    model.actorAudience({ name: "QA final review replay" }),
    "test-candidate",
  );
  assert.equal(
    model.actorAudience({ name: "Website Designer" }),
    "conversation",
  );
});
test("work GET uses owned conversation links, no execution or reconciliation mutations", () => {
  const source = readFileSync("app/api/work/route.ts", "utf8");
  assert.doesNotMatch(
    source,
    /refreshTask|control_mission|reconcile[A-Z]|\.rpc\(/,
  );
  assert.match(source, /owned\.get\(p.chat_id\) === p.actor_id/);
  assert.match(source, /delegationReplyId/);
  assert.match(source, /projectReplyId/);
});
test("UI metadata migration denies public access and rejects stale writes without changing execution", () => {
  const sql = readFileSync(
    "supabase/migrations/20261020152655_workspace_presentation_state.sql",
    "utf8",
  );
  assert.match(sql, /enable row level security/);
  assert.match(sql, /current_row.version<>p_version/);
  assert.doesNotMatch(
    sql,
    /update (actors|agent_missions|work_projects|agent_tasks) set/i,
  );
});

test("cancelled delegations preserve execution evidence without generating stale decisions", () => {
  const row = item("mission", "cancelled", {
    status: "blocked",
    coordinationState: "cancelled",
  });
  assert.equal(model.needsYou(row), false);
  assert.equal(model.isActive(row), false);
  assert.equal(model.workLabel(row), "Stopped");
  assert.equal(row.status, "blocked");
});
