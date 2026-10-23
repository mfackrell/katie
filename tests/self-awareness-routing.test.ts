import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const src=readFileSync("app/api/chat/route.ts","utf8");
test("direct self-awareness prompts activate scoped self-repository discovery",()=>{
 assert.ok(src.includes("see|view|understand|know|examine|look at|access"));
 assert.ok(src.includes("message: selfInspectionRequest ?"));
 assert.ok(src.includes("Inspect repository source and architecture."));
});
test("self-inspection preserves opt-out and actor boundaries",()=>{
 assert.ok(src.includes("!activeRepoId && repoInjectionEnabled && selfInspectionRequest && !currentAgentTask()"));
 assert.ok(src.includes('selfActor?.name?.trim().toLowerCase() === "katie"'));
});
