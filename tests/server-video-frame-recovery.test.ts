import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
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

test("ten frame timestamps cover the whole recording, including late scene transitions", () => {
  assert.equal(MAX_VIDEO_FALLBACK_FRAMES, 10);
  assert.equal(VIDEO_FRAME_SAMPLE_FRACTIONS.length, 10);
  assert.deepEqual(evenVideoSampleTimestamps(120), [8.4,24,39.6,55.2,70.8,86.4,100.8,110.4,116.4,119.4]);
  assert.deepEqual(evenVideoSampleTimestamps(1), [0.07,0.2,0.33,0.46,0.59,0.72,0.84,0.92,0.95]);
  assert.deepEqual(evenVideoSampleTimestamps(null), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(evenVideoSampleTimestamps(120).at(-1)! > 119,
    "the final sample must be taken within the last 1% of a full recording");
});

test("real bundled FFmpeg decodes a private MP4 into verified JPEG frames", async () => {
  if (!ffmpeg) return;
  const dir = await mkdtemp(join(tmpdir(), "katie-ffmpeg-test-"));
  try {
    const videoPath = join(dir, "test.mp4");
    // Actual generated frames exercise the packaged decoder. A browser mock
    // would have missed the iPhone recording codec failure in production.
    await execFileAsync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "color=c=blue:s=160x96:r=4:d=3",
      "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-y", videoPath,
    ], { timeout: 20_000 });
    const video = await readFile(videoPath);
    const frames = await extractFramesFromPrivateVideo(new Blob([new Uint8Array(video)], { type: "video/mp4" }));
    assert.equal(frames.length, 10, "a decodable three-second video must yield all ten samples");
    frames.forEach((frame, index) => {
      assert.ok(Number.isInteger(frame.timestampSeconds * 4), "actual PTS must land on the 4 fps decoder grid");
      if (index) assert.ok(frame.timestampSeconds >= frames[index - 1].timestampSeconds);
    });
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

test("FFmpeg captures a genuine scene change confined to the final 4% of a clip", async () => {
  if (!ffmpeg) return;
  const dir = await mkdtemp(join(tmpdir(), "katie-video-tail-test-"));
  try {
    const videoPath = join(dir, "tail-transition.mp4");
    // Blue dominates 96% of this recording. Only the closing 200ms are red.
    // The old uniform 10-frame sampler stopped at 90.9%, missing the cut.
    await execFileAsync(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=blue:s=160x96:r=10:d=4.8",
      "-f", "lavfi", "-i", "color=c=red:s=160x96:r=10:d=0.2",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-c:v", "mpeg4", "-pix_fmt", "yuv420p",
      "-y", videoPath,
    ], { timeout: 20_000 });
    const original = await readFile(videoPath);
    const frames = await extractFramesFromPrivateVideo(
      new Blob([new Uint8Array(original)], { type: "video/mp4" }),
    );
    assert.equal(frames.length, 10);
    const firstFrame = Buffer.from(frames[0].dataUrl.slice("data:image/jpeg;base64,".length), "base64");
    const lastFrame = Buffer.from(frames.at(-1)!.dataUrl.slice("data:image/jpeg;base64,".length), "base64");
    const beginningPixel = await sharp(firstFrame).raw().toBuffer();
    const finalPixel = await sharp(lastFrame).raw().toBuffer();
    assert.ok(beginningPixel[2] > beginningPixel[0] * 2, "first scene should be blue");
    assert.ok(finalPixel[0] > finalPixel[2] * 2, "last sampled scene must be red");
    assert.ok(frames.at(-1)!.timestampSeconds >= 4.8, "late sampling must reach the short ending");
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
