import test from "node:test";
import assert from "node:assert/strict";
import {
  parseIntermediateMemoryDraft,
  stringifyIntermediateMemoryContent,
} from "../lib/chat/intermediate-memory-editor";

test("parseIntermediateMemoryDraft rejects invalid json", () => {
  assert.throws(() => parseIntermediateMemoryDraft("{oops"), /valid JSON/);
});

test("parseIntermediateMemoryDraft rejects non-object json", () => {
  assert.throws(() => parseIntermediateMemoryDraft("[]"), /JSON object/);
  assert.throws(() => parseIntermediateMemoryDraft("\"hello\""), /JSON object/);
});

test("parse/stringify helpers support editor load/save flow", () => {
  const content = { summary: "S", tags: ["a"] };
  const draft = stringifyIntermediateMemoryContent(content);
  const parsed = parseIntermediateMemoryDraft(draft);

  assert.deepEqual(parsed, content);
});
