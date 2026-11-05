import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = readFileSync("components/chat-panel.tsx", "utf8");
const sectionStart = panel.indexOf('aria-label="Project approvals and recovery"');
const sectionEnd = panel.indexOf("</section>", sectionStart);

test("mobile approvals are inside their own height-bounded, touch-scrollable region", () => {
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart, "approval region exists");
  const block = panel.slice(sectionStart, sectionEnd);
  assert.match(block, /max-h-\\[45dvh\\]/);
  assert.match(block, /min-h-0/);
  assert.match(block, /overflow-y-auto/);
  assert.match(block, /touch-pan-y/);
  assert.match(block, /WebkitOverflowScrolling:\\s*"touch"/);
  for (const component of [
    "LifecycleOwnerApproval",
    "Task4aContinuationOwnerApproval",
    "Task4aSavedSpecificationRecovery",
    "Task4aSuccessorOwnerApproval",
    "Task4aNativeRecoveryApproval",
    "DeveloperResourceCard",
    "ProjectApprovalCard",
  ]) {
    assert.ok(block.includes("<" + component), component + " remains reachable in the scrolling region");
  }
});

test("the separate conversation scroll region and composer are preserved", () => {
  assert.ok(sectionEnd < panel.indexOf('ref={messagesContainerRef}', sectionEnd),
    "owner approval region remains separate from the message history");
  assert.match(panel, /ref=\\{messagesContainerRef\\}[\\s\\S]*?overflow-y-auto/);
  assert.match(panel, /<ChatComposerInput/);
});
