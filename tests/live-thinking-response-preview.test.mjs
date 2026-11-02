import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const panel = readFileSync('components/reasoning-explainer-panel.tsx', 'utf8');
const chat = readFileSync('components/chat-panel.tsx', 'utf8');
test('thinking panel presents existing streamed answer only while loading', () => {
  assert.match(panel, /streamingAnswer\?: string/);
  assert.match(panel, /loading && streamingAnswer \?/);
  assert.match(panel, /aria-label="Live response preview"/);
  assert.match(panel, /streamingAnswer\.slice\(-1600\)/);
  assert.match(panel, /!state\.startedAt && !streamingAnswer/);
});
test('status rail and popup share the existing chat delta state', () => {
  assert.equal((chat.match(/streamingAnswer=\{streamingAnswer\}/g) ?? []).length, 2);
  assert.match(chat, /if \(chunk\.type === "delta"\) \{\s*textContent \+= chunk\.text;\s*setStreamingAnswer\(textContent\)/);
  assert.match(chat, /<AssistantMarkdown>\{streamingAnswer\}<\/AssistantMarkdown>/);
});
