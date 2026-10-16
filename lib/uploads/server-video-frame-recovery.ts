import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import sharp from "sharp";
import { registerVideoTiming } from "./video-timing";
import { validateVideoFallbackFrames, VIDEO_FRAME_SAMPLE_FRACTIONS, type VideoFallbackFrame } from "./video-fallback-frames";

export const MAX_FALLBACK_SOURCE_BYTES = 200 * 1024 * 1024;
const VIDEO_PROBE_TIMEOUT_MS = 8_000;
const FRAME_DECODE_TIMEOUT_MS = 12_000;

type CommandResult = { code: number | null; stderr: string };
type FfmpegRun = (binary: string, args: string[], timeoutMs: number) => Promise<CommandResult>;

/**
 * Bundled static Linux FFmpeg supports codecs omitted from headless Chromium
 * (including phone HEVC/H.264 recordings). Never fetch a public media URL.
 * The original remains in private Supabase Storage and is copied only to a
 * temporary per-invocation directory that is deleted on success and failure.
 */
function ffmpegBinary(): string {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Native video frame extraction requires the Linux x64 server runtime.");
  }
  // Resolve against the module location first: a Vercel function bundle does
  // not necessarily retain node_modules below process.cwd().
  const candidates: string[] = [];
  try {
    // Works in Next.js server functions and the CommonJS test runner.
    const require = createRequire(join(process.cwd(), "package.json"));
    candidates.push(join(dirname(require.resolve("@ffmpeg-installer/linux-x64/package.json")), "ffmpeg"));
  } catch {
    // Resolution may be unavailable with externalized optional packages.
  }
  candidates.push(join(process.cwd(), "node_modules", "@ffmpeg-installer", "linux-x64", "ffmpeg"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Native FFmpeg decoder is unavailable in this deployment.");
}

async function runFfmpeg(binary: string, args: string[], timeoutMs: number, keepTail = false): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env },
    });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, result?: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Video decoder timed out."));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      if (keepTail) { stderr = (stderr + chunk.toString("utf8")).slice(-16_000); return; }
      if (stderr.length < 16_000) stderr += chunk.toString("utf8").slice(0, 16_000 - stderr.length);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(undefined, { code, stderr }));
  });
}

function videoDuration(stderr: string): number | null {
  const match = /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function evenVideoSampleTimestamps(duration: number | null): number[] {
  // If FFmpeg cannot determine duration, probe ten successive seconds rather
  // than assuming a short clip. Invalid timestamps are simply skipped.
  if (duration === null || !Number.isFinite(duration) || duration <= 0) {
    return VIDEO_FRAME_SAMPLE_FRACTIONS.map((_, index) => index);
  }
  const maxSeek = Math.max(0, duration - 0.05);
  return [...new Set(VIDEO_FRAME_SAMPLE_FRACTIONS.map(fraction =>
    Math.min(maxSeek, Math.max(0, duration * fraction)).toFixed(3)))].map(Number);
}

/** Decode actual video frames, never fake evidence or a metadata-only summary. */
export async function extractFramesFromPrivateVideo(
  source: Blob,
  options: { binary?: string; run?: FfmpegRun; window?: { start: number; end: number } } = {},
): Promise<VideoFallbackFrame[]> {
  if (!source.size || source.size > MAX_FALLBACK_SOURCE_BYTES) {
    throw new Error("Saved video is missing or exceeds the 200 MB server decoder limit.");
  }
  if (options.window && (!Number.isFinite(options.window.start) || !Number.isFinite(options.window.end) ||
      options.window.start < 0 || options.window.end <= options.window.start || options.window.end - options.window.start > 30 || options.window.end > 86400)) {
    throw new Error("Timeline windows must be finite, increasing and at most 30 seconds.");
  }
  const binary = options.binary ?? ffmpegBinary();
  const run = options.run ?? runFfmpeg;
  const workspace = await mkdtemp(join(tmpdir(), "katie-video-"));
  const inputPath = join(workspace, "original.mp4");
  try {
    await writeFile(inputPath, Buffer.from(await source.arrayBuffer()));
    const probe = await run(binary, ["-hide_banner", "-nostdin", "-i", inputPath], VIDEO_PROBE_TIMEOUT_MS);
    const duration = videoDuration(probe.stderr);
    const frames: VideoFallbackFrame[] = [];
    const measured: number[] = [];
    const originMatch = /start:\s*(-?\d+(?:\.\d+)?)/.exec(probe.stderr);
    const origin = originMatch ? Number(originMatch[1]) : null;
    // Container duration may be elapsed length (e.g. MPEG-TS) or include the
    // origin. Preserve full tail coverage when those semantics are unknown;
    // the late-seek retries below handle seeks beyond the last visible frame.
    if (options.window && (origin !== 0 || duration === null || options.window.start >= duration || options.window.end > duration)) {
      throw new Error("Timeline extraction requires trusted zero-origin duration and an in-source interval.");
    }
    const timestamps = options.window
      ? Array.from({ length: 10 }, (_, i) => options.window!.start + (options.window!.end - options.window!.start) * i / 9)
      : evenVideoSampleTimestamps(duration);
    // Decode ten snapshots covering the timeline, with extra attention to
    // the last visible scene. Near-end seeks can run beyond the last decodable
    // frame on low-FPS clips; retry slightly earlier rather than silently
    // dropping the crucial end frames. Never fabricate an image.
    const deadline = Date.now() + (options.window ? 60_000 : 125_000);
    for (let index = 0; index < timestamps.length && Date.now() < deadline; index++) {
      const ending = Boolean(options.window && index === timestamps.length - 1);
      const seconds = ending ? Math.max(options.window!.start, options.window!.end - 2) : timestamps[index];
      const output = join(workspace, `frame-${index}.jpg`);
      const nearEnd = index >= timestamps.length - 3;
      const attempts = ending ? [seconds] : nearEnd
        ? [...new Set([seconds, seconds - 0.15, seconds - 0.35, seconds - 0.65]
            .map(value => Math.max(0, Number(value.toFixed(3)))))]
        : [seconds];
      for (const seekSeconds of attempts) {
        if (Date.now() >= deadline) break;
        try {
          const decodeArgs = [
            "-nostdin", "-hide_banner", "-loglevel", "info", "-copyts",
            "-ss", String(seekSeconds), ...(ending ? ["-t", String(options.window!.end - seekSeconds)] : []), "-i", inputPath,
            "-an", "-sn", "-dn", "-vf", "scale=w=\'min(960,iw)\':h=\'min(960,ih)\':force_original_aspect_ratio=decrease,showinfo", "-vsync", "0", "-frames:v", ending ? "1000" : "1",
            ...(ending ? ["-update", "1"] : []), "-q:v", "5", "-y", output,
          ];
          const result = options.window ? await (options.run ?? ((binary, args, timeout) => runFfmpeg(binary, args, timeout, true)))(binary, decodeArgs,
            Math.min(FRAME_DECODE_TIMEOUT_MS, Math.max(2_000, deadline - Date.now()))) : await run(binary, [
            "-nostdin", "-hide_banner", "-loglevel", "info",
            "-copyts",
            "-ss", String(seekSeconds), "-i", inputPath,
            "-an", "-sn", "-dn", "-vf", "showinfo", "-vsync", "0", "-frames:v", "1",
            // Sharp downsizes only large frames without enlarging tiny clips.
            "-q:v", "5", "-y", output,
          ], Math.min(FRAME_DECODE_TIMEOUT_MS, Math.max(2_000, deadline - Date.now())));
          if (result.code !== 0 || (ending && /\bn:\s*(?:999|[1-9]\d{3,})\s+pts:/.test(result.stderr))) continue;
          const decoded = await readFile(output);
          // Sharp enforces the same tight evidence size cap as browser previews.
          const jpg = await sharp(decoded)
            .rotate()
            .resize({ width: 960, withoutEnlargement: true })
            .jpeg({ quality: 57, mozjpeg: true })
            .toBuffer();
          if (jpg.length > 350_000) continue;
          const ptsMatch = ending
            ? [...result.stderr.matchAll(/\bn:\s*\d+\s+pts:.*?pts_time:\s*(\S+)/g)].at(-1)
            : /\bn:\s*0\s+pts:.*?pts_time:\s*(\S+)/.exec(result.stderr);
          const numericPts = ptsMatch && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(ptsMatch[1])
            ? Number(ptsMatch[1]) : null;
          const pts = numericPts !== null && origin !== null ? numericPts - origin : null;
          const validPts = pts !== null && Number.isFinite(pts) && pts >= 0 && (duration === null || pts <= duration);
          if (options.window && (!validPts || pts! < options.window.start || pts! > options.window.end ||
              measured.includes(pts!))) continue;
          if (validPts) measured.push(pts!);
          frames.push({
            timestampSeconds: validPts ? pts! : seekSeconds,
            dataUrl: "data:image/jpeg;base64," + jpg.toString("base64"),
          });
          break;
        } catch {
          // Retry a late sample at an earlier decodable time; other samples proceed.
        }
      }
    }
    if (!frames.length) {
      console.warn("[Video Routing] native video decoder returned no frames", {
        videoBytes: source.size, detectedDuration: duration, triedSamples: timestamps.length,
        probeError: options.window ? undefined : probe.stderr.slice(0, 350),
      });
      throw new Error("FFmpeg could not extract visible frames from the saved recording.");
    }
    console.info("[Video Routing] FFmpeg decoded retained recording", {
      frameCount: frames.length, durationSeconds: duration, videoBytes: source.size,
    });
    frames.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
    measured.sort((a, b) => a - b);
    const validated = validateVideoFallbackFrames(frames);
    if (measured.length === validated.length) registerVideoTiming(validated, { version: 1, durationSeconds: origin === 0 ? duration : null, sampleSeconds: measured });
    return validated;
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Metadata probe only; never infer an elapsed endpoint for nonzero-origin media. */
export async function probeTimelineDuration(source: Blob): Promise<number | null> {
  if (!source.size || source.size > MAX_FALLBACK_SOURCE_BYTES) throw new Error("Invalid timeline source size.");
  const workspace = await mkdtemp(join(tmpdir(), "katie-video-probe-"));
  try {
    const input = join(workspace, "original.mp4");
    await writeFile(input, Buffer.from(await source.arrayBuffer()));
    const result = await runFfmpeg(ffmpegBinary(), ["-hide_banner", "-nostdin", "-i", input], VIDEO_PROBE_TIMEOUT_MS);
    const origin = /start:\s*(-?\d+(?:\.\d+)?)/.exec(result.stderr);
    const duration = videoDuration(result.stderr);
    return origin && Number(origin[1]) === 0 && duration !== null && duration <= 86400 ? duration : null;
  } finally { await rm(workspace, { recursive: true, force: true }); }
}
