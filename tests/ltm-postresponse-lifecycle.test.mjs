import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

test("normal completed chat registers memory persistence before closing stream", () => {
  const source=readFileSync("app/api/chat/route.ts","utf8");
  const registered=source.indexOf('after(async () => {\n              console.log("[Chat API] Memory persistence start"');
  const closed=source.indexOf("if (!streamCancelled) {\n              controller.close();",registered);
  assert.ok(registered>0 && closed>registered,"LTM after callback must register before stream close");
  const segment=source.slice(registered,closed);
  assert.ok(segment.includes("maybeUpdateLongTermMemory(actorId, chatId, message)"));
  assert.ok(segment.includes("maybeUpdateSummary(chatId)"));
});
