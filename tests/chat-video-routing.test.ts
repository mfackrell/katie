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

test("Grok video fallback requires actual frames rather than claiming native MP4 analysis", () => {
  const video = {
    fileId: "v1", fileName: "clip.mp4", mimeType: "video/mp4",
    preview: "Video metadata only", attachmentKind: "video" as const,
    providerRef: { googleFileUri: "https://provider.example/clip" },
  };
  const notReady = getAttachmentSupportForProvider("grok", [video]);
  assert.equal(notReady.supported, false);
  if (!notReady.supported) assert.match(notReady.reason, /no decoded frames/);
  assert.deepEqual(getAttachmentSupportForProvider("grok", [{
    ...video, videoFrames: [{ timestampSeconds: 1.2, dataUrl: "data:image/jpeg;base64,/9j/2Q==" }]
  }]), { supported: true });
});

test("legacy video originals can arm a safe Grok fallback before pixels are decoded", () => {
  const video = {
    fileId: "older-video-id", fileName: "saved.mp4", mimeType: "video/mp4",
    preview: "metadata", attachmentKind: "video" as const
  };
  assert.equal(getAttachmentSupportForProvider("grok", [video]).supported, false);
  assert.deepEqual(getAttachmentSupportForProvider("grok", [video],
    new Set(["older-video-id"])), { supported: true });
  assert.equal(getAttachmentSupportForProvider("grok", [video],
    new Set(["another-video-id"])).supported, false);
});
