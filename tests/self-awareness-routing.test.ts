import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const src=readFileSync("app/api/chat/route.ts","utf8");
test("direct self-awareness prompts trigger scoped self-repository discovery",()=>{
 assert.match(src,/\b\(\?:see\|view\|understand\|know\|examine\|look at\|access\)/);
 assert.match(src,/message: selfInspectionRequest \? /);
 assert.match(src,/Inspect repository source and architecture/);
});
test("self-inspection still respects user repository-injection opt-out and actor identity",()=>{
 assert.match(src,/!activeRepoId && repoInjectionEnabled && selfInspectionRequest && !currentAgentTask\(\)/);
 assert.match(src,/selfActor\?\.name\?\.trim\(\)\.toLowerCase\(\) === "katie"/);
});
