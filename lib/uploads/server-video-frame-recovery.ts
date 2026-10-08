import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import sharp from "sharp";
import { validateVideoFallbackFrames, type VideoFallbackFrame } from "./video-fallback-frames";

export const MAX_FALLBACK_SOURCE_BYTES = 200 * 1024 * 1024;
const MAX_SAMPLE_SECONDS = 18;
const VIDEO_PROBE_TIMEOUT_MS = 8_000;
const FRAME_DECODE_TIMEOUT_MS = 12_000;
const requireNode = createRequire(import.meta.url);

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
  try {
    return requireNode.resolve("@ffmpeg-installer/linux-x64/ffmpeg");
  } catch {
    throw new Error("Native FFmpeg decoder is unavailable in this deployment.");
  }
}

async function runFfmpeg(binary: string, args: string[], timeoutMs: number): Promise<CommandResult> {
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

function samples(duration: number | null): number[] {
  if (duration === null) return [0, 1, 3, 6];
  const maxSeek = Math.max(0, duration - 0.08);
  return [...new Set([0.08, 0.33, 0.62, 0.88].map(fraction =>
    Math.min(maxSeek, Math.max(0, duration * fraction)).toFixed(3)))].map(Number);
}

/** Decode actual video frames, never fake evidence or a metadata-only summary. */
export async function extractFramesFromPrivateVideo(
  source: Blob,
  options: { binary?: string; run?: FfmpegRun } = {},
): Promise<VideoFallbackFrame[]> {
  if (!source.size || source.size > MAX_FALLBACK_SOURCE_BYTES) {
    throw new Error("Saved video is missing or exceeds the 200 MB server decoder limit.");
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
    const timestamps = samples(duration);
    // Decode only four snapshots and limit CPU to avoid starving the chat handler.
    // An unreadable timestamp should not prevent inspection of other positions.
    const deadline = Date.now() + 65_000;
    for (let index = 0; index < timestamps.length && Date.now() < deadline; index++) {
      const seconds = timestamps[index];
      const output = join(workspace, `frame-${index}.jpg`);
      try {
        const result = await run(binary, [
          "-nostdin", "-hide_banner", "-loglevel", "error",
          "-ss", String(seconds), "-i", inputPath,
          "-an", "-sn", "-dn", "-frames:v", "1",
          "-vf", "scale=960:-2:force_original_aspect_ratio=decrease",
          "-q:v", "5", "-y", output,
        ], Math.min(FRAME_DECODE_TIMEOUT_MS, Math.max(2_000, deadline - Date.now())));
        if (result.code !== 0) continue;
        const decoded = await readFile(output);
        // Sharp enforces the same tight evidence size cap as browser previews.
        const jpg = await sharp(decoded)
          .rotate()
          .resize({ width: 960, withoutEnlargement: true })
          .jpeg({ quality: 57, mozjpeg: true })
          .toBuffer();
        if (jpg.length > 350_000) continue;
        frames.push({
          timestampSeconds: Math.round(seconds * 10) / 10,
          dataUrl: "data:image/jpeg;base64," + jpg.toString("base64"),
        });
      } catch {
        // Try the next actual timestamp; never invent a frame.
      }
    }
    if (!frames.length) {
      console.warn("[Video Routing] native video decoder returned no frames", {
        videoBytes: source.size, detectedDuration: duration, triedSamples: timestamps.length,
        probeError: probe.stderr.slice(0, 350),
      });
      throw new Error("FFmpeg could not extract visible frames from the saved recording.");
    }
    console.info("[Video Routing] FFmpeg decoded retained recording", {
      frameCount: frames.length, durationSeconds: duration, videoBytes: source.size,
    });
    return validateVideoFallbackFrames(frames);
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}
