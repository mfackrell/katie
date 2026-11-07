import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const composer = readFileSync("components/chat-composer-input.tsx", "utf8");

test("composer recalculates textarea height on external clears and conversation resets", () => {
  assert.match(composer, /useEffect\(\(\) => \{\s*scheduleResize\(\);\s*\}, \[props\.externalValue, props\.resetVersion\]\)/);
  assert.match(composer, /textarea\.style\.height = "auto"/);
  assert.match(composer, /Math\.min\(textarea\.scrollHeight, 192\)/);
});

test("local typing still resizes independently of debounced draft persistence", () => {
  assert.match(composer, /setValue\(next\);\s*scheduleResize\(\);/);
  assert.match(composer, /setTimeout\(\(\) => \{\s*lastCommitted\.current = next/);
});
