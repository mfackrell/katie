import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = readFileSync("components/chat-panel.tsx", "utf8");
const composer = readFileSync("components/chat-composer-input.tsx", "utf8");

test("text-only sending is not gated by pending attachment recovery", () => {
  assert.match(composer, /props\.attachmentsReady \|\| hasText/);
  assert.match(composer, /disabled=\{!canSend\}/);
  assert.match(panel, /attachmentsReady \|\| text\.trim\(\)\.length > 0/);
  assert.doesNotMatch(panel, /if \(loading \|\| !attachmentsReady/);
});

test("attachment-only sending still waits for attachment hydration", () => {
  assert.match(panel, /selectedImages\.length > 0/);
  assert.match(panel, /selectedVideos\.length > 0/);
  assert.match(panel, /selectedFiles\.length > 0/);
  assert.match(panel, /fileReferences\.length > 0/);
  assert.match(composer, /!props\.hasAttachments \|\| props\.composerAttachmentsReady/);
  assert.match(panel, /!hasComposerAttachments \|\| composerAttachmentsReady/);
  assert.match(panel, /hasComposerAttachments && !composerAttachmentsReady/);
});
