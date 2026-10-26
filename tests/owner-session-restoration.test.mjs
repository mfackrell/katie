import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src=readFileSync("components/self-tools-owner-session.tsx","utf8");
test("owner session distinguishes recovery from logged-out state",()=>{
  assert.match(src,/sessionReady/);
  assert.match(src,/Restoring owner session/);
  assert.match(src,/event === "INITIAL_SESSION"/);
  assert.match(src,/event === "TOKEN_REFRESHED"/);
});
test("late null getSession cannot replace successful auth event",()=>{
  const segment=src.slice(src.indexOf("void client.auth.getSession()"),src.indexOf("return ()=>{active=false"));
  assert.doesNotMatch(segment,/setSignedIn\(Boolean\(data\.session\)\)/);
  assert.match(segment,/else if \(data.session\)/);
});
