import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = readFileSync("components/chat-panel.tsx", "utf8");
const composer = readFileSync("components/chat-composer-input.tsx", "utf8");
const browser = readFileSync("scripts/presentation-browser-acceptance.mjs", "utf8");

test("per-keystroke state belongs to an isolated composer rather than ChatPanel", () => {
  assert.match(composer, /export const ChatComposerInput = memo\(/);
  assert.match(composer, /const \[value, setValue\] = useState\(props\.externalValue\)/);
  assert.match(composer, /props\.currentValueRef\.current = next;\s*setValue\(next\)/);
  assert.doesNotMatch(composer, /props\.onDraftChange\(next\);\s*setValue\(next\)/);
  assert.match(composer, /setTimeout\(\(\) => \{\s*lastCommitted\.current = next;\s*props\.onDraftChange\(next\)/);
  assert.doesNotMatch(panel, /function handleInputChange\(/);
  assert.match(panel, /<ChatComposerInput[\s\S]*?currentValueRef=\{composerValueRef\}/);
  assert.match(panel, /const latestComposerText = composerValueRef\.current\.trim\(\)/);
});

test("send, recovery, attachments, emoji and replies remain connected to the composer", () => {
  assert.match(panel, /resetComposerInput\(value => value \+ 1\)/);
  assert.match(panel, /My reply:\\n\$\{latestComposerText\}/);
  assert.match(panel, /fileControl=\{<>/);
  assert.match(panel, /emojiControl=\{<>/);
  assert.match(composer, /onKeyDown=\{props\.onKeyDown\}/);
  assert.match(composer, /onPaste=\{props\.onPaste\}/);
  assert.match(composer, /disabled=\{!canSend\}/);
  assert.match(composer, /props\.onCancel/);
  assert.match(panel, /sessionStorage\.setItem\(`katie\.draft\.v1\.\$\{chatId\}`,input\)/);
});

test("historical assistant message Markdown and reactions are memoized", () => {
  assert.match(panel, /const MemoizedAssistantMarkdown = memo\(AssistantMarkdown\)/);
  assert.match(panel, /const MemoizedMessageReactions = memo\(MessageReactions\)/);
  assert.match(panel, /<MemoizedAssistantMarkdown>\{message\.content\}/);
  assert.match(panel, /<MemoizedMessageReactions[\s\S]*?onReaction=\{onMessageReaction\}/);
});

test("Chromium acceptance measures short/long-thread p95 latency, React commits, long tasks and drafts", () => {
  assert.match(browser, /historySize = 160/);
  assert.match(browser, /<Profiler id="chat" onRender=\{onChatRender\}>/);
  assert.match(browser, /p95 >= 50/);
  assert.match(browser, /result\.commits > result\.strokes \* 2 \+ 4/);
  assert.match(browser, /PerformanceObserver\(/);
  assert.match(browser, /recoveredDraft !== shortTyping\.text/);
  assert.match(browser, /Quick Enter should send without waiting for draft debounce/);
});

test("programmatic composer edits force local input synchronization without relying on debounced draft echo", () => {
  assert.match(panel, /composerValueRef\.current = nextValue;\s*setInput\(nextValue\);\s*resetComposerInput\(version=>version\+1\)/);
  assert.match(panel, /setInput\(SAVED_DOCUMENT_EXPORT_PROMPT\);\s*resetComposerInput\(version=>version\+1\)/);
  assert.match(panel, /setInput\("Change this project's scope: "\);\s*resetComposerInput\(version=>version\+1\)/);
  assert.match(panel, /setInput\(content\);\s*resetComposerInput\(version=>version\+1\);\s*setStatusMessage\(httpCause\)/);
});
