import test from "node:test";
import assert from "node:assert/strict";
import {selfCodeChangeIntent,startProjectIntent} from "../lib/projects/chat";

test("explicit request to change Katie's own repository can enter approved development intake",()=>{
 for(const text of ["Fix your GitHub repository routing code", "Please modify Katie's source code to restore self-inspection", "Update your codebase to fix the bug"]){
  assert.equal(selfCodeChangeIntent(text),true,text);
  assert.equal(startProjectIntent(text),true,text);
 }
});
test("inspection, ordinary conversation, and prohibitions cannot launch write intake",()=>{
 for(const text of ["Why can't you inspect your repository?", "Show me your GitHub code", "Review your backend code read-only", "Do not modify your repository", "Fix this proposal", "it"]){
  assert.equal(selfCodeChangeIntent(text),false,text);
 }
});
