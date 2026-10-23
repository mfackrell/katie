import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const src=readFileSync("app/api/chat/route.ts","utf8");
test("natural self-awareness prompts request Katie's own repository evidence",()=>{
 assert.ok(src.includes("see|view|understand|know|examine|look at|access"));
 assert.ok(src.includes("message: (selfInspectionRequest || continuitySelfInspection) ?"));
 assert.ok(src.includes("Inspect Katie own source code and routing implementation."));
});
test("explicit self inspection can override only current source gate, not general user setting",()=>{
 assert.ok(src.includes("ownSourceInspectionAuthorized && activeRepoContext?.repositoryFullName === \"mfackrell/katie\""));
 assert.ok(src.includes('selfActor?.name?.trim().toLowerCase() === "katie" && selfActor.actor_kind === "standard"'));
 assert.ok(src.includes("ownSourceInspectionAuthorized && !activeRepoId"));
 assert.ok(src.includes("const repoInjectionEnabled = currentAgentTask() ? false : repoInjectionEnabledFromPayload !== false"));
});
