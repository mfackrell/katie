import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { extractFramesFromPrivateVideo, evenVideoSampleTimestamps } from "../lib/uploads/server-video-frame-recovery";
import { MAX_VIDEO_FALLBACK_FRAMES, VIDEO_FRAME_SAMPLE_FRACTIONS } from "../lib/uploads/video-fallback-frames";
import { pruneRepeatedVideoSelections, uniqueAttachmentReferences } from "../lib/chat/video-attachment-dedup";

const requireNode = createRequire(join(process.cwd(), "package.json"));
const ffmpeg = process.platform === "linux" && process.arch === "x64"
  ? requireNode.resolve("@ffmpeg-installer/linux-x64/ffmpeg")
  : null;

test("ten frame timestamps are evenly distributed across video duration", () => {
  assert.equal(MAX_VIDEO_FALLBACK_FRAMES, 10);
  assert.equal(VIDEO_FRAME_SAMPLE_FRACTIONS.length, 10);
  assert.deepEqual(evenVideoSampleTimestamps(120), [6, 18, 30, 42, 54, 66, 78, 90, 102, 114]);
  assert.deepEqual(evenVideoSampleTimestamps(1), [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95]);
  assert.deepEqual(evenVideoSampleTimestamps(null), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("real bundled FFmpeg decodes a private MP4 into verified JPEG frames", async () => {
  if (!ffmpeg) return;
  const dir = await mkdtemp(join(tmpdir(), "katie-ffmpeg-test-"));
  try {
    const videoPath = join(dir, "test.mp4");
    // Actual generated frames exercise the packaged decoder. A browser mock
    // would have missed the iPhone recording codec failure in production.
    execFileSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "color=c=blue:s=160x96:r=4:d=3",
      "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-y", videoPath,
    ], { timeout: 20_000 });
    const video = await readFile(videoPath);
    const frames = await extractFramesFromPrivateVideo(new Blob([new Uint8Array(video)], { type: "video/mp4" }));
    assert.equal(frames.length, 10, "a decodable three-second video must yield all ten samples");
    assert.deepEqual(frames.map(frame => frame.timestampSeconds),
      evenVideoSampleTimestamps(3).map(value => Math.round(value * 10) / 10));
    assert.ok(frames.every(frame => frame.dataUrl.startsWith("data:image/jpeg;base64,")));
    assert.ok(frames.every(frame => frame.timestampSeconds >= 0 && frame.timestampSeconds < 3));
    for (const frame of frames) {
      const pixels = Buffer.from(frame.dataUrl.slice("data:image/jpeg;base64,".length), "base64");
      const metadata = await sharp(pixels).metadata();
      assert.equal(metadata.format, "jpeg");
      assert.equal(metadata.width, 160);
      assert.equal(metadata.height, 96);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid saved bytes must not produce synthetic images and decoder errors are clear", async () => {
  if (!ffmpeg) return;
  await assert.rejects(extractFramesFromPrivateVideo(new Blob([])), /missing or exceeds/);
  await assert.rejects(extractFramesFromPrivateVideo(
    new Blob([Buffer.from("not a real MP4")], { type: "video/mp4" })
  ), /FFmpeg could not extract visible frames/);
});

test("a new video suppresses the same saved video even when its file ID changed", () => {
  const fresh = [{
    fileId: "new-id", fileName: " ScreenRecording.mp4 ", mimeType: "video/mp4",
    preview: "new", attachmentKind: "video" as const, providerRef: { googleFileUri: "file/new" },
  }];
  const saved = [
    { mode: "source" as const, attachment: { id: "saved-id", fileName: "screenrecording.mp4", mimeType: "video/mp4" } },
    { mode: "source" as const, attachment: { id: "other", fileName: "notes.pdf", mimeType: "application/pdf" } },
  ];
  assert.deepEqual(pruneRepeatedVideoSelections(fresh, saved, "Look at this video"),
    [saved[1]], "only video duplication is removed, other file selections remain");
  assert.deepEqual(pruneRepeatedVideoSelections(fresh, saved, "Compare this recording with the earlier one"),
    saved, "explicit comparisons must retain both original sources");
});

test("deduplication keys on exact identity or provider URI, not filenames alone", () => {
  const video = {
    fileId: "vid-a", fileName: "screen.mp4", mimeType: "video/mp4", preview: "a",
    attachmentKind: "video" as const, providerRef: { googleFileUri: "files/original" },
  };
  const same = { ...video, fileId: "vid-b" };
  const different = { ...video, fileId: "vid-c", providerRef: { googleFileUri: "files/different" } };
  assert.deepEqual(uniqueAttachmentReferences([video, same, different, video]), [video, different],
    "keep genuinely distinct recordings when they share filenames");
});
