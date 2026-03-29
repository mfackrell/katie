import test from "node:test";
import assert from "node:assert/strict";
import { buildFileReferences } from "../lib/uploads/build-file-references";
import { inferRequestIntent } from "../lib/router/model-intent";

function withUploadKeysDisabled(fn: () => Promise<void>): Promise<void> {
  const prevOpenAi = process.env.OPENAI_API_KEY;
  const prevGoogle = process.env.GOOGLE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  return fn().finally(() => {
    if (prevOpenAi) {
      process.env.OPENAI_API_KEY = prevOpenAi;
    }
    if (prevGoogle) {
      process.env.GOOGLE_API_KEY = prevGoogle;
    }
  });
}

test("buildFileReferences accepts supported video types", async () => {
  await withUploadKeysDisabled(async () => {
    const files = [
      new File([new Uint8Array([1, 2, 3])], "clip.mp4", { type: "video/mp4" }),
      new File([new Uint8Array([1, 2, 3])], "screen.mov", { type: "video/quicktime" }),
      new File([new Uint8Array([1, 2, 3])], "demo.webm", { type: "video/webm" }),
      new File([new Uint8Array([1, 2, 3])], "recording.m4v", { type: "video/x-m4v" })
    ];

    const refs = await buildFileReferences(files);

    assert.equal(refs.length, 4);
    refs.forEach((ref) => {
      assert.equal(ref.attachmentKind, "video");
      assert.match(ref.preview, /Video attachment metadata only/);
      assert.ok(ref.mimeType.startsWith("video/"));
    });
  });
});

test("buildFileReferences rejects unsupported video MIME types", async () => {
  await withUploadKeysDisabled(async () => {
    await assert.rejects(
      buildFileReferences([new File([new Uint8Array([9])], "legacy.avi", { type: "video/avi" })]),
      /Unsupported file type/
    );
  });
});

test("buildFileReferences rejects mismatched video extension", async () => {
  await withUploadKeysDisabled(async () => {
    await assert.rejects(
      buildFileReferences([new File([new Uint8Array([9])], "not-really-video.txt", { type: "video/mp4" })]),
      /Unsupported file type/
    );
  });
});

test("video-bearing requests are not treated as text-only intent", async () => {
  assert.equal(
    await inferRequestIntent("Summarize what happens in this upload.", { hasImages: false, hasVideoInput: true }),
    "vision-analysis"
  );
  assert.equal(
    await inferRequestIntent("Analyze this clip and project the trend over time.", { hasImages: false, hasVideoInput: true }),
    "multimodal-reasoning"
  );
});
