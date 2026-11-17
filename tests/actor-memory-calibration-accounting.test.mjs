import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const api=readFileSync("app/api/actors/route.ts","utf8");
const ui=readFileSync("components/specialist-directory.tsx","utf8");

test("actor memory calibration uses authenticated durable accounting, never an unscoped provider call",()=>{
  assert.match(api,/if\(raw\?\.calibration === "preview"\)/);
  assert.match(api,/const actorId=z\.string\(\)\.uuid\(\)\.parse\(raw\.actorId\)/);
  assert.match(api,/const chatId=z\.string\(\)\.uuid\(\)\.parse\(raw\.chatId\)/);
  assert.match(api,/return await executeStandaloneWorkflow\(request,\{calibration:"preview",actorId,chatId\}/);
  assert.match(api,/async\(\)=>calibrationPreview\(actorId\)/);
  assert.doesNotMatch(api,/if\(raw\?\.calibration === "preview"\) return calibrationPreview/);
  assert.match(api,/NextResponse\.json\(\{error:error instanceof Error\?error\.message:"Calibration unavailable"\},\{status:503\}\)/);
});

test("calibration binds the actor's existing chat, uses a request ID, and handles empty API replies",()=>{
  assert.match(ui,/chatId=\{active\[0\]\?\.id\}/);
  assert.match(ui,/if\(!chatId\) throw Error\(/);
  assert.match(ui,/calibration:"preview",actorId:actor\.id,chatId\},crypto\.randomUUID\(\)/);
  assert.match(ui,/"x-request-id":requestId/);
  assert.match(ui,/try \{data=JSON\.parse\(text\)/);
  assert.match(ui,/response\.status===202/);
});

test("calibration accepts omitted empty suggestion arrays but retains structural checks",()=>{
  assert.match(api,/Array\.isArray\(parsed\.groups\?\?\[\]\)/);
  assert.match(api,/Array\.isArray\(parsed\.conflicts\?\?\[\]\)/);
  assert.match(api,/typeof parsed!=="object"\|\|Array\.isArray\(parsed\)/);
  assert.match(api,/if\(!\["redundancy","irrelevant"\]\.includes\(item\.type\)\)continue/);
});
