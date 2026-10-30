import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {isExplicitKatieSelfInspectionRequest} from "../lib/tools/self-inspection-intent";

const src=readFileSync("app/api/chat/route.ts","utf8");

test("explicit self-inspection activates Katie's own repository evidence",()=>{
  for (const prompt of [
    "Can you see yourself?",
    "Inspect your own code.",
    "Katie, check your repository logs.",
  ]) {
    assert.equal(isExplicitKatieSelfInspectionRequest(prompt), true, prompt);
  }
  assert.ok(src.includes("isExplicitKatieSelfInspectionRequest(message)"));
  assert.ok(src.includes("message: (selfInspectionRequest || continuitySelfInspection) ?"));
  assert.ok(src.includes("Inspect Katie own source code and routing implementation."));
});

test("conversational self-awareness is not a repository inspection request",()=>{
  for (const prompt of [
    "Do you understand yourself?",
    "When you think to yourself, do you experience a voice in your head?",
    "You simply know what you're thinking without words.",
  ]) {
    assert.equal(isExplicitKatieSelfInspectionRequest(prompt), false, prompt);
  }
});

test("explicit self inspection can override only current source gate, not general user setting",()=>{
 assert.ok(src.includes("ownSourceInspectionAuthorized && activeRepoContext?.repositoryFullName === \"mfackrell/katie\""));
 assert.ok(src.includes('selfActor?.name?.trim().toLowerCase() === "katie" && selfActor.actor_kind === "standard"'));
 assert.ok(src.includes("ownSourceInspectionAuthorized && !activeRepoId"));
 assert.ok(src.includes("const repoInjectionEnabled = currentAgentTask() || isGuestSession ? false : repoInjectionEnabledFromPayload !== false"));
});
