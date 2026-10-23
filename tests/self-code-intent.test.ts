import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const source=readFileSync("lib/projects/chat.ts","utf8");
const from=source.indexOf("export function selfCodeChangeIntent");
const to=source.indexOf("export function startProjectIntent",from);
assert.ok(from >= 0 && to > from);
const declaration=source.slice(from,to)
  .replace("export function selfCodeChangeIntent(text: string): boolean", "function selfCodeChangeIntent(text)");
const matches=runInNewContext(declaration+"\nselfCodeChangeIntent",{});

test("clear instructions to edit Katie source are eligible for managed development",()=>{
 for(const message of ["Fix your GitHub repository routing code", "Please modify Katie's source code to restore self-inspection", "Update your codebase to fix the bug"]){
  assert.equal(matches(message),true,message);
 }
 assert.match(source,/export function startProjectIntent\(text: string\) \{\s*if\(selfCodeChangeIntent\(text\)\)return true/);
});
test("questions and prohibitions do not activate self-code write intent",()=>{
 for(const message of ["Why can't you inspect your repository?", "Show me your GitHub code", "Review your backend code read-only", "Do not modify your repository", "Fix this proposal", "it"]){
  assert.equal(matches(message),false,message);
 }
});
