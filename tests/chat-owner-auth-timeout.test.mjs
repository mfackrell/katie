import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("lib/tools/browser-owner-session.ts", "utf8");
const panel = readFileSync("components/chat-panel.tsx", "utf8");

test("optional owner session lookup cannot indefinitely block ordinary chat", () => {
  assert.match(source, /Promise\.race\(/);
  assert.match(source, /setTimeout\(\(\) => resolve\(null\), 4000\)/);
  assert.match(source, /clearTimeout\(timeout\)/);
  assert.match(panel, /const ownerBearer = await ownerSessionBearer\(\)/);
  assert.match(panel, /await fetch\("\/api\/chat"/);
});
