import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const route=readFileSync("app/api/chat/route.ts","utf8");
test("self inspection binds Katie's connected own repository without bypassing explicit selection",()=>{
 assert.match(route,/if \(!activeRepoId && repoInjectionEnabled && selfInspectionRequest && !currentAgentTask\(\)\)/);
 assert.match(route,/selfActor\?\.name\?\.trim\(\)\.toLowerCase\(\) === "katie"/);
 assert.match(route,/\.eq\("repository_full_name","mfackrell\/katie"\)/);
 assert.match(route,/const effectiveRepoId = activeRepoId \?\? selfRepoId/);
});
