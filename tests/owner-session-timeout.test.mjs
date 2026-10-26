import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=readFileSync("components/self-tools-owner-session.tsx","utf8");
test("owner auth recovery has a bounded visible failure state",()=>{
 assert.match(source,/recoveryTimeout = window\.setTimeout/);
 assert.match(source,/6000\)/);
 assert.match(source,/restoration timed out/);
 assert.match(source,/window\.clearTimeout\(recoveryTimeout\)/);
});
