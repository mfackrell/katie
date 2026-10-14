import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractFramesFromPrivateVideo } from "../lib/uploads/server-video-frame-recovery";
import { getVideoTiming, formatVideoTiming } from "../lib/uploads/video-timing";

test("fixture retains measured duration and decoded PTS rather than requested seeks", async () => {
  const bytes = await readFile("fixtures/runpod/synthetic-red-blue.mp4");
  const frames = await extractFramesFromPrivateVideo(new Blob([bytes]));
  const timing = getVideoTiming(frames);
  assert.equal(timing?.durationSeconds, 2);
  assert.equal(timing?.sampleSeconds.length, 10);
  for (const seconds of timing!.sampleSeconds) {
    assert.ok(Math.abs(seconds * 12 - Math.round(seconds * 12)) < 0.001);
  }
  assert.notEqual(timing!.sampleSeconds[0], 0.14);
  assert.match(formatVideoTiming(timing), /does not establish the exact onset/);
});

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import sharp from "sharp";
import { registerVideoTiming, validateVideoTiming } from "../lib/uploads/video-timing";
import { buildVideoConversationEvidence } from "../lib/chat/video-evidence";
import { buildContextualVideoReplyPrompt } from "../lib/chat/video-response";
const qwen = "The video begins with a solid red background. In the center of the frame is a white square. At 0.3 seconds, the background color abruptly changes to solid blue, while the white square remains unchanged in position and size. The video ends at 1.6 seconds with the blue background and the white square still visible, with no further changes or transitions occurring.";
const grok = "A solid red field fills the frame, with a plain white square centered on it. The square stays the same size and position. Partway through, the background switches abruptly from red to solid blue while the white square remains unchanged. The clip ends on that same blue field and centered white square, with no further color, shape, or scene change.";

test("independent full decode verifies fixture ground truth and sampled visible colors", async () => {
  const bytes = await readFile("fixtures/runpod/synthetic-red-blue.mp4");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "42cc3d66eaa3307822a034c05febeb34b4364278cf8f56a9ca1621d46a1f3803");
  const binary = createRequire(join(process.cwd(), "package.json")).resolve("@ffmpeg-installer/linux-x64/ffmpeg");
  const raw = await decodeCommand(binary, ["-v", "error", "-i", "fixtures/runpod/synthetic-red-blue.mp4", "-vf", "scale=96:96", "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  const stride = 96 * 96 * 3;
  assert.equal(raw.length / stride, 24);
  for (let i = 0; i < 24; i++) {
    const offset = i * stride;
    assert.ok(i < 12 ? raw[offset] > raw[offset + 2] * 2 : raw[offset + 2] > raw[offset] * 2);
    const center = offset + (48 * 96 + 48) * 3;
    assert.ok([...raw.subarray(center, center + 3)].every(channel => channel > 220));
  }
  const frames = await extractFramesFromPrivateVideo(new Blob([bytes]));
  for (const frame of frames) {
    const rgb = await sharp(Buffer.from(frame.dataUrl.split(",")[1], "base64")).raw().toBuffer();
    assert.ok(frame.timestampSeconds < 1 ? rgb[0] > rgb[2] * 2 : rgb[2] > rgb[0] * 2);
  }
});

test("saved reports stay verbatim while assembled synthesis evidence corrects timing and agreement", () => {
  const evidence = buildVideoConversationEvidence({ runpodText: qwen, grokText: grok,
    timing: { version: 1, durationSeconds: 2, sampleSeconds: [0.166667, 0.416667, 0.666667, 1, 1.25, 1.5, 1.75, 1.91667, 1.91667, 1.91667] } });
  const prompt = buildContextualVideoReplyPrompt("Describe the clip", evidence);
  assert.ok(prompt.includes(qwen));
  assert.ok(prompt.includes(grok));
  assert.match(prompt, /measured duration: 2s/);
  assert.match(prompt, /Omission is neither contradiction nor confirmation/);
  assert.match(prompt, /not independent corroboration/);
  assert.match(prompt, /does not establish the exact onset/);
  assert.doesNotMatch(prompt, /DETAILED FACTUAL|Use both reports as factual|GROK INDEPENDENT/);
  // Semantic acceptance example, not a claim that a live model was executed:
  const expected = "The 2.0-second clip starts red and switches to blue, with the white square staying centered and unchanged. It ends on blue.";
  assert.ok(expected.includes("white square"));
});

test("client fields cannot register timing and malformed cached measurements are rejected", () => {
  const forged = { decoderTiming: { version: 1, durationSeconds: 2, sampleSeconds: [0.3] }, provenance: "server" };
  assert.equal(getVideoTiming(forged), undefined);
  assert.equal(getVideoTiming({ ...forged }), undefined);
  for (const bad of [null, {}, { version: 0, durationSeconds: 2, sampleSeconds: [1] },
    { version: 1, durationSeconds: -1, sampleSeconds: [1] },
    { version: 1, durationSeconds: 2, sampleSeconds: [1, 0] },
    { version: 1, durationSeconds: 2, sampleSeconds: [3] },
    { version: 1, durationSeconds: 2, sampleSeconds: [NaN] }]) assert.equal(validateVideoTiming(bad), undefined);
  assert.match(formatVideoTiming(), /No server-verified timing/);
  const target = {};
  registerVideoTiming(target, { version: 1, durationSeconds: 2, sampleSeconds: [0, 1] });
  assert.equal(getVideoTiming(target)?.durationSeconds, 2);
  assert.equal(getVideoTiming({ ...target }), undefined);
});

async function decodeCommand(binary: string, args: string[]): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Decoder test timed out")); }, 20000);
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(stderr)); });
  });
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
test("nonzero origin and variable-rate frames preserve source-relative decoded PTS", async () => {
  const binary = createRequire(join(process.cwd(), "package.json")).resolve("@ffmpeg-installer/linux-x64/ffmpeg");
  const dir = await mkdtemp(join(tmpdir(), "katie-timing-test-"));
  try {
    const path = join(dir, "offset.mkv");
    await decodeCommand(binary, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=96x96:r=12:d=2", "-vf", "select='not(mod(n,3))',setpts=PTS+5/TB", "-vsync", "0", "-c:v", "ffv1", "-y", path]);
    const frames = await extractFramesFromPrivateVideo(new Blob([await readFile(path)]));
    const timing = getVideoTiming(frames);
    // Matroska's header duration includes the offset in this decoder version.
    // It must not be promoted to a measured clip length.
    assert.equal(timing?.durationSeconds, null);
    assert.ok(timing!.sampleSeconds.every(s => s >= 0 && s < 2));
    assert.ok(timing!.sampleSeconds.every(s => Math.abs(s * 4 - Math.round(s * 4)) < 0.01));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("cached timing must match the exact emitted frame positions", () => {
  const reference = { mimeType: "video/mp4", videoFrames: [{ timestampSeconds: 0.5 }] };
  registerVideoTiming(reference, { version: 1, durationSeconds: 2, sampleSeconds: [0.3] });
  assert.equal(getVideoTiming(reference), undefined);
  registerVideoTiming(reference, { version: 1, durationSeconds: 2, sampleSeconds: [0.5, 1] });
  assert.equal(getVideoTiming(reference), undefined);
  registerVideoTiming(reference, { version: 1, durationSeconds: 2, sampleSeconds: [0.5] });
  assert.equal(getVideoTiming(reference)?.sampleSeconds[0], 0.5);
});

test("unknown duration and missing PTS stay explicitly unknown after real decoding", async () => {
  const bytes = await readFile("fixtures/runpod/synthetic-red-blue.mp4");
  const run = async (binary: string, args: string[], timeoutMs: number) => await new Promise<{code: number | null; stderr: string}>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Decoder timed out")); }, timeoutMs);
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({code, stderr: stderr.replace(/Duration:\s*\d+:\d+:\d+(?:\.\d+)?/, "Duration: N/A")}); });
  });
  const unknownDuration = await extractFramesFromPrivateVideo(new Blob([bytes]), { run });
  assert.equal(getVideoTiming(unknownDuration)?.durationSeconds, null);
  assert.deepEqual(getVideoTiming(unknownDuration)?.sampleSeconds, [0, 1]);
  const noPts = await extractFramesFromPrivateVideo(new Blob([bytes]), { run: async (...args) => {
    const result = await run(...args);
    return { ...result, stderr: result.stderr.replace(/pts_time:/g, "unknown_time:") };
  } });
  assert.equal(getVideoTiming(noPts), undefined);
  assert.match(formatVideoTiming(getVideoTiming(noPts)), /may be approximate requested seeks/);
});
