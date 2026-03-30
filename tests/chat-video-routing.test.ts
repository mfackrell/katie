import test from "node:test";
import assert from "node:assert/strict";
import { getAttachmentSupportForProvider, resolveVideoRoutingPolicy } from "../lib/chat/video-routing";

test("video attachment with no override forces google routing", () => {
  const policy = resolveVideoRoutingPolicy(true, undefined);
  assert.equal(policy.mode, "force-google");
});

test("video attachment with overrideProvider=google is allowed", () => {
  const policy = resolveVideoRoutingPolicy(true, "google");
  assert.equal(policy.mode, "manual-google");
});

test("video attachment with overrideProvider=openai is rejected", () => {
  const policy = resolveVideoRoutingPolicy(true, "openai");
  assert.equal(policy.mode, "reject-override");
  if (policy.mode === "reject-override") {
    assert.equal(policy.provider, "openai");
  }
});

test("video attachment missing googleFileUri fails with clear error", () => {
  const support = getAttachmentSupportForProvider("google", [
    {
      fileId: "file-1",
      fileName: "clip.mp4",
      mimeType: "video/mp4",
      preview: "Video attachment metadata only",
      attachmentKind: "video"
    }
  ]);

  assert.equal(support.supported, false);
  if (!support.supported) {
    assert.match(support.reason, /Missing Google file URI/);
  }
});

test("non-video attachments keep normal provider support behavior", () => {
  const support = getAttachmentSupportForProvider("openai", [
    {
      fileId: "file-2",
      fileName: "notes.txt",
      mimeType: "text/plain",
      preview: "Some text",
      attachmentKind: "text"
    }
  ]);

  assert.equal(resolveVideoRoutingPolicy(false, undefined).mode, "normal");
  assert.deepEqual(support, { supported: true });
});
