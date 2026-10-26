import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const chat = readFileSync("components/chat-panel.tsx", "utf8");
const view = readFileSync("components/structured-response-view.tsx", "utf8");

test("canonical assistant Markdown remains visible when rich blocks are present", () => {
  assert.match(chat, /<AssistantMarkdown>\{message\.content\}<\/AssistantMarkdown>/);
  assert.match(chat, /message\.presentation && <StructuredResponseView/);
  assert.doesNotMatch(chat, /message\.presentation \? <StructuredResponseView/);
});

test("duplicate Markdown visual blocks are excluded from auxiliary rendering", () => {
  assert.match(view, /response\.blocks\.filter\(block => ordered \|\| block\.type !== "markdown"\)/);
});

test("streamed blocks are parsed and checked against canonical prose", () => {
  assert.match(chat, /parseStructuredResponse\(chunk\.presentation\)/);
  assert.match(chat, /verified\.fallbackMarkdown === chunk\.text/);
  assert.match(chat, /parseStructuredResponse\(trailingChunk\.presentation\)/);
});
