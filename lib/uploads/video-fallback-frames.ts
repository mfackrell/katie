import type { FileReference } from "@/lib/providers/types";

export type VideoFallbackFrame = NonNullable<FileReference["videoFrames"]>[number];
export const MAX_VIDEO_FALLBACK_FRAMES = 4;
const MAX_FRAME_BYTES = 350_000;

export function validateVideoFallbackFrames(value: unknown): VideoFallbackFrame[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_VIDEO_FALLBACK_FRAMES) {
    throw new Error("Invalid video preview frames.");
  }
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid video preview frame.");
    const frame = item as Partial<VideoFallbackFrame>;
    if (typeof frame.timestampSeconds !== "number" || !Number.isFinite(frame.timestampSeconds) ||
        frame.timestampSeconds < 0 || frame.timestampSeconds > 86400 ||
        typeof frame.dataUrl !== "string" || !frame.dataUrl.startsWith("data:image/jpeg;base64,")) {
      throw new Error("Invalid video frame preview.");
    }
    const base64 = frame.dataUrl.slice("data:image/jpeg;base64,".length);
    if (!base64 || base64.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4 ||
        base64.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(base64)) {
      throw new Error("Invalid video frame payload.");
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > MAX_FRAME_BYTES || bytes.length < 8 || bytes.toString("base64") !== base64 ||
        bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
      throw new Error("Invalid JPEG video preview.");
    }
    return { timestampSeconds: frame.timestampSeconds, dataUrl: frame.dataUrl };
  });
}

// Capture a small visual evidence set while the original file is still available
// to the browser. xAI currently accepts image inputs, not private video files.
// Failure here never prevents the original upload to Gemini.
export async function captureVideoFallbackFrames(file: File): Promise<VideoFallbackFrame[]> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return [];
  const video = document.createElement("video");
  const url = URL.createObjectURL(file);
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  const timeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Video frame decoding timed out.")), ms);
      promise.then(x => { clearTimeout(timer); resolve(x); }, e => { clearTimeout(timer); reject(e); });
    });
  const event = (eventName: string, ms: number) => timeout(new Promise<void>((resolve, reject) => {
    const done = () => { video.removeEventListener(eventName, done); video.removeEventListener("error", fail); };
    const success = () => { done(); resolve(); };
    const fail = () => { done(); reject(new Error("Could not decode video preview.")); };
    video.addEventListener(eventName, success, { once: true });
    video.addEventListener("error", fail, { once: true });
  }), ms);

  try {
    if (video.readyState < 1) {
      const loaded = event("loadedmetadata", 8000);
      video.load();
      await loaded;
    }
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) return [];
    const width = Math.min(video.videoWidth, 960);
    const height = Math.max(1, Math.round(video.videoHeight * width / video.videoWidth));
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return [];
    const frames: VideoFallbackFrame[] = [];
    for (const fraction of [0.08, 0.33, 0.62, 0.88]) {
      const second = Math.max(0, Math.min(video.duration - 0.05, video.duration * fraction));
      try {
        if (Math.abs(video.currentTime - second) > 0.03) {
          const seeked = event("seeked", 4000);
          video.currentTime = second;
          await seeked;
        }
        context.drawImage(video, 0, 0, width, height);
        let dataUrl = canvas.toDataURL("image/jpeg", 0.62);
        if (dataUrl.length > MAX_FRAME_BYTES * 4 / 3) {
          dataUrl = canvas.toDataURL("image/jpeg", 0.42);
        }
        if (dataUrl.startsWith("data:image/jpeg;base64,") &&
            dataUrl.length <= MAX_FRAME_BYTES * 4 / 3) {
          frames.push({ timestampSeconds: Math.round(second * 10) / 10, dataUrl });
        }
      } catch { /* Still sample any other decodable points. */ }
    }
    return frames;
  } catch {
    return [];
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
