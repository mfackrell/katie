import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const shared = fs.readFileSync('lib/memory/assemble-context.ts', 'utf8');
const policy = fs.readFileSync('lib/chat/adaptive-response-composition.ts', 'utf8');
const panel = fs.readFileSync('components/chat-panel.tsx', 'utf8');
const route = fs.readFileSync('app/api/chat/route.ts', 'utf8');

test('actor context carries one provider-independent presentation policy', () => {
  assert.match(shared, /getAdaptiveResponseCompositionInstruction\(\)/);
  assert.match(shared, /currentAgentTask\(\)\?\.snapshot\.instructions \?\? actor\.purpose/);
  assert.match(shared, /MEMORY_ARCHITECTURE_GUIDE/);
});

test('policy selects natural formatting without templates or fake status', () => {
  assert.match(policy, /greetings, banter/);
  assert.match(policy, /Markdown table/);
  assert.match(policy, /fenced code blocks/);
  assert.match(policy, /verified/);
  assert.match(policy, /actor identity/);
  assert.match(policy, /context-appropriate emoji/);
  assert.match(policy, /do not make every message emoji-free by default/);
  assert.match(policy, /Never add an emoji merely to fill a quota/);
});

test('existing GitHub-flavored Markdown rendering and stream remain intact', () => {
  assert.match(panel, /ReactMarkdown/);
  assert.match(panel, /remarkPlugins=\{\[remarkGfm\]\}/);
  assert.match(panel, /decoder\.decode\(value, \{ stream: true \}\)/);
  assert.match(route, /new ReadableStream<Uint8Array>/);
});
