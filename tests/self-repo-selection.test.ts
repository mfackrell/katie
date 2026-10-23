import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const src=readFileSync("lib/repo/content-injector.ts","utf8");
const route=readFileSync("app/api/chat/route.ts","utf8");
test("Katie own architecture selects actual implementation files rather than alphabetic workflow defaults",()=>{
 assert.ok(src.includes("Architecture-aware selection"));
 for(const p of ["app/api/chat/route.ts","lib/router/master-router.ts","lib/repo/content-injector.ts","lib/chat/local-katie.ts"]) assert.ok(src.includes(p));
 assert.ok(src.indexOf("if (selfArchitecture && !hints.length)") < src.indexOf(".slice(0, 12)"));
});
test("follow-up source selection favors self-inspection intent rather than unrelated image context",()=>{
 assert.ok(route.includes("continuitySelfInspection"));
 assert.ok(route.includes("recentUserTopic"));
 assert.ok(route.includes("Katie own routing source architecture"));
});
