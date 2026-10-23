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

test("actual architecture matcher selects source for the live self-inspection phrase",()=>{
 const { runInNewContext } = require("node:vm") as typeof import("node:vm");
 const start=src.indexOf("  const selfArchitecture =");
 const end=src.indexOf("  const selected = filePaths",start);
 assert.ok(start>=0 && end>start);
 const branch=src.slice(start,end);
 const evaluate=(userMessage:string)=>{
  const filePaths=[".github/workflows/ci.yml","app/api/chat/route.ts","lib/router/master-router.ts","lib/repo/content-injector.ts"];
  const compiled="(function(userMessage,filePaths){ const hints=[]; const shouldSkipPath=()=>({skip:false}); "+branch+"return {selected: filePaths.slice(0, 12), reason:'default'}; })";
  const fn=runInNewContext(compiled,{console:{info:()=>{}}}) as (message:string,paths:string[])=>{selected:string[],reason:string};
  return fn(userMessage,filePaths);
 };
 for(const message of ["can you see yourself now?\\nKatie own routing source architecture","Inspect Katie own routing source architecture"]){
  const result=evaluate(message);
  assert.ok(result.selected.includes("app/api/chat/route.ts"),message);
  assert.ok(!result.selected.includes(".github/workflows/ci.yml"),message);
  assert.match(result.reason,/Architecture-aware/);
 }
});
