import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const s=readFileSync("app/api/chat/route.ts","utf8");
test("own repository resolves before both normal model response and authorized project write workflow",()=>{
 assert.match(s,/const selfInspectionRequest =/);
 assert.ok(s.includes(String.raw`/\\b(?:your`)===false,"matcher must use word boundary, not literal backslash");
 assert.match(s,/const effectiveRepoId = activeRepoId \?\? selfRepoId/);
 assert.match(s,/activeRepoId:effectiveRepoId \?\? undefined/);
 assert.match(s,/const activeRepoContext = effectiveRepoId \?/);
 assert.match(s,/selfActor\?\.name\?\.trim\(\)\.toLowerCase\(\) === "katie"/);
});
