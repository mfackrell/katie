import type { Browser } from "playwright-core";
import { launchWebsiteBrowser } from "@/lib/research/website-evidence";
import { validateVideoFallbackFrames, type VideoFallbackFrame } from "./video-fallback-frames";

export const MAX_FALLBACK_SOURCE_BYTES = 60 * 1024 * 1024;
const DECODE_TIMEOUT_MS = 55_000;

/**
 * Extract real JPEG pixels, not a filename/metadata summary, from a private
 * original video retained in Supabase. The bytes never go to a public URL,
 * external media service, or the user's browser.
 *
 * Reuses Katie's Chromium/Playwright runtime already bundled for website
 * inspections. Decoding unsupported codecs must fail explicitly.
 */
export async function extractFramesFromPrivateVideo(
  source: Blob,
  options: { launch?: () => Promise<Browser> } = {},
): Promise<VideoFallbackFrame[]> {
  if (!source.size || source.size > MAX_FALLBACK_SOURCE_BYTES) {
    throw new Error("Server video fallback supports retained files up to 60 MB; this source is outside that limit.");
  }
  const media = "data:" + (source.type || "video/mp4") + ";base64," +
    Buffer.from(await source.arrayBuffer()).toString("base64");
  const browser = await (options.launch ?? launchWebsiteBrowser)();
  try {
    const page = await browser.newPage();
    // The media is already stored privately and supplied as an in-memory data
    // URL. No external browser network requests are necessary or permitted.
    await page.route("**/*", route => route.abort());
    await page.setContent("<!doctype html><html><body></body></html>");
    const extraction = page.evaluate(async (videoDataUrl: string) => {
      const video = document.createElement("video");
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      const once = (event: string, timeoutMs: number) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { cleanup(); reject(new Error("Video decode timed out: " + event)); }, timeoutMs);
          const ready = () => { cleanup(); resolve(); };
          const failed = () => { cleanup(); reject(new Error("The saved video codec is unsupported by the server decoder.")); };
          const cleanup = () => {
            clearTimeout(timer);
            video.removeEventListener(event, ready);
            video.removeEventListener("error", failed);
          };
          video.addEventListener(event, ready, { once: true });
          video.addEventListener("error", failed, { once: true });
        });
      try {
        video.src = videoDataUrl;
        if (video.readyState < 1) await once("loadedmetadata", 12_000);
        if (video.readyState < 2) await once("loadeddata", 10_000);
        if (!Number.isFinite(video.duration) || video.duration <= 0 ||
            !video.videoWidth || !video.videoHeight) {
          throw new Error("Unable to decode frames from the retained video.");
        }
        const canvas = document.createElement("canvas");
        canvas.width = Math.min(960, video.videoWidth);
        canvas.height = Math.max(1, Math.round(video.videoHeight * canvas.width / video.videoWidth));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Server video frame drawing is unavailable.");
        const frames: Array<{ timestampSeconds: number; dataUrl: string }> = [];
        for (const fraction of [0.08, 0.33, 0.62, 0.88]) {
          const second = Math.max(0, Math.min(Math.max(0, video.duration - 0.05), video.duration * fraction));
          try {
            if (Math.abs(video.currentTime - second) > 0.03) {
              const ready = once("seeked", 7_000);
              video.currentTime = second;
              await ready;
            }
            if (video.readyState < 2) await once("loadeddata", 7_000);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            let jpeg = canvas.toDataURL("image/jpeg", 0.58);
            if (jpeg.length > 450_000) jpeg = canvas.toDataURL("image/jpeg", 0.35);
            if (jpeg.startsWith("data:image/jpeg;base64,") && jpeg.length < 450_000) {
              frames.push({ timestampSeconds: Math.round(second * 10) / 10, dataUrl: jpeg });
            }
          } catch { /* Decode other sample points; never create synthetic images. */ }
        }
        if (!frames.length) throw new Error("The saved video could not be decoded into actual visual frames.");
        return frames;
      } finally {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    }, media);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const frames = await Promise.race([
        extraction,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Server video extraction exceeded 55 seconds.")), DECODE_TIMEOUT_MS);
        }),
      ]);
      return validateVideoFallbackFrames(frames);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}
