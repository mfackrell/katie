import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const chat = readFileSync("components/chat-panel.tsx", "utf8");
const persistence = readFileSync("lib/data/persistence-store.ts", "utf8");

test("message timestamps come from persisted createdAt, not render time", () => {
  assert.match(persistence, /createdAt: row\.created_at/);
  assert.match(chat, /<time\s+dateTime=\{message\.createdAt\}/);
  assert.match(chat, /new Date\(message\.createdAt\)/);
  assert.doesNotMatch(chat, /<time\s+dateTime=\{new Date\(\)/);
});

test("timestamps use reader locale, readable date and time, and absolute UTC tooltip", () => {
  assert.match(chat, /new Intl\.DateTimeFormat\(undefined,\s*\{/);
  assert.match(chat, /dateStyle: "medium"/);
  assert.match(chat, /timeStyle: "short"/);
  assert.match(chat, /title=\{new Date\(message\.createdAt\)\.toISOString\(\)\}/);
  assert.match(chat, /!Number\.isNaN\(Date\.parse\(message\.createdAt\)\)/);
});
