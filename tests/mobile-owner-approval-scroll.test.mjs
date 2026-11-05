import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = readFileSync("components/chat-panel.tsx", "utf8");
const sectionStart = panel.indexOf('aria-label="Project approvals and recovery"');
const sectionEnd = panel.indexOf("</section>", sectionStart);

test("mobile approvals are inside their own height-bounded, touch-scrollable region", () => {
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart, "approval region exists");
  const block = panel.slice(sectionStart, sectionEnd);
  for (const css of ["min-h-0", "max-h-[45dvh]", "sm:max-h-[55dvh]", "overflow-y-auto", "touch-pan-y", 'WebkitOverflowScrolling: "touch"']) {
    assert.ok(block.includes(css), "missing mobile approval scroll contract: " + css);
  }
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
  const messageRef = panel.indexOf('ref={messagesContainerRef}', sectionEnd);
  assert.ok(messageRef > sectionEnd, "approval region remains separate from the message history");
  assert.ok(panel.slice(messageRef, messageRef + 500).includes("overflow-y-auto"), "message history stays scrollable");
  assert.ok(panel.includes("<ChatComposerInput"), "chat composer remains mounted");
});
