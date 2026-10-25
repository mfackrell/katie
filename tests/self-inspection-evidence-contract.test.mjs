import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const self=readFileSync("lib/tools/self-inspection.ts","utf8");
const loop=readFileSync("lib/tools/loop.ts","utf8");
const contract=readFileSync("lib/tools/inspection-evidence.ts","utf8");

test("self-inspection binds SHA evidence to authorized existing model tool loop",()=>{
 assert.match(self,/name: 'self_inspection_evidence'/);
 assert.match(self,/reconcileSelfInspectionEvidence\(\{repositorySha,runtimeSha\}\)/);
 assert.match(self,/name: 'github_source_paths'/);
 assert.match(self,/name: 'github_read_file'/);
 assert.match(self,/blobSha:file.sha/);
 assert.match(self,/return runModelTools\(/);
 assert.match(self,/authorizeSelfToolCaller/);
 assert.match(self,/self_tool_receipts/);
});
test("model guidance enforces provenance, pagination and behavioral uncertainty",()=>{
 for(const phrase of ["self_inspection_evidence","github_source_paths","nextOffset","startLine","blobSha","independently verified production alias","behavior tests"])
   assert.ok(loop.includes(phrase),phrase);
});
test("contract separates runtime matches from independently verified production and behavior",()=>{
 assert.match(contract,/sourceRuntime/);
 assert.match(contract,/productionAliasVerified === true/);
 assert.match(contract,/sourceProduction/);
 assert.match(contract,/behaviorVerification: 'untested'/);
});
