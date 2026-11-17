import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync('components/reasoning-explainer-panel.tsx', 'utf8');
const chat = readFileSync('components/chat-panel.tsx', 'utf8');

test('thinking panel shows status and collaboration, never streamed answer content', () => {
  assert.doesNotMatch(panel, /streamingAnswer\?: string|Live response preview|streamingAnswer\.slice/);
  assert.match(panel, /collaborationActivity/);
  assert.match(panel, /statusMessage/);
});

test('central conversation progress owns live assistant text while the right rail stays status-only', () => {
  assert.equal((chat.match(/streamingAnswer=\{streamingAnswer\}/g) ?? []).length, 0);
  assert.match(chat, /aria-label="Katie response progress"/);
  assert.match(chat, /aria-label="Streaming assistant response"/);
  assert.match(chat, /<AssistantMarkdown>\{streamingAnswer\}<\/AssistantMarkdown>/);
  assert.match(chat, /if \(chunk\.type === "delta"\) \{\s*textContent \+= chunk\.text;\s*if \(!answerCommitted\) setStreamingAnswer\(textContent\)/);
});
