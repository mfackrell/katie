import type { ProviderResponse } from "@/lib/providers/types";

/**
 * RunPod is the last-resort image backend for provider-generation failures.
 * Caller must have observed failures from BOTH Grok and Google in this request.
 * Explicit moderation/safety rejections are not eligible for circumvention.
 */
export type ImageProviderFailure = { provider: "grok" | "google"; error: string };

const MODERATION = /prohibited[_ -]?content|content[_ -]?moderat|moderation|\bsafety\b|\bpolicy\b|\brefus(?:al|ed)\b|\bdeclin(?:e|ed)\b|\bdenied\b|\bnot permitted\b|\bviolation\b|\bnsfw\b|\bblocked\b|\bdisallowed\b|\binappropriate\b/i;
const TECHNICAL = /(?:\b429\b|\b50[0-9]\b|\b52[0-9]\b|\b503\b|\b504\b|rate.?limit|too many requests|timeout|timed out|overload|temporar(?:ily|y)|econnreset|econnrefused|etimedout|fetch failed|network error|service unavailable|gateway timeout|connection (?:lost|reset|failed))/i;

export function isModerationImageFailure(error: unknown): boolean {
  const value = error instanceof Error ? error.message : String(error ?? "");
  return MODERATION.test(value);
}

export function isTechnicalImageFailure(error: unknown): boolean {
  const value = error instanceof Error ? error.message : String(error ?? "");
  return !isModerationImageFailure(error) && TECHNICAL.test(value);
}

export function shouldTryRunpodImage(input: {
  failures: ImageProviderFailure[];
  enabled: boolean;
  hasReferenceImages: boolean;
}): boolean {
  if (!input.enabled || input.hasReferenceImages) return false;
  // A content decision from ANY attempt is terminal for the whole request,
  // even if an earlier attempt to that provider had a technical error.
  if (input.failures.some(f => MODERATION.test(f.error))) return false;
  return input.failures.some(f => f.provider === "grok" && Boolean(f.error.trim())) &&
    input.failures.some(f => f.provider === "google" && Boolean(f.error.trim()));
}


/** Public RunPod endpoint: already deployed by RunPod, so no private GPU worker is needed. */
export const RUNPOD_IMAGE_MODEL_ID = "black-forest-labs-flux-1-schnell";
const IMAGE_URL_HOST = "image.runpod.ai";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export function runpodImageConfigured(): boolean {
  return Boolean(process.env.RUNPOD_API_KEY);
}

function mimeFromImage(image: Buffer): string {
  if (image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) return "image/jpeg";
  if (image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("RunPod returned an unsupported image format.");
}

function checkedImageUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("RunPod image URL missing.");
  let u: URL;
  try { u = new URL(value); } catch { throw new Error("Invalid RunPod image URL."); }
  if (u.protocol !== "https:" || u.hostname !== IMAGE_URL_HOST || u.port ||
      u.username || u.password || !u.pathname.startsWith("/")) {
    throw new Error("RunPod returned an untrusted image URL.");
  }
  return u.href;
}

async function collectImageBytes(response: Response): Promise<Buffer> {
  if (!response.ok) throw new Error(`RunPod image download failed (HTTP ${response.status}).`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error("RunPod image exceeds size limit.");
  if (!response.body) throw new Error("RunPod image response is empty.");
  const reader = response.body.getReader();
  let total = 0;
  const chunks: Buffer[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("RunPod image exceeds size limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  if (total < 16) throw new Error("RunPod image is empty or truncated.");
  return Buffer.concat(chunks, total);
}

/**
 * Public FLUX.1 Schnell model: POST prompt -> COMPLETED output.image_url
 * (expiring after seven days). Download immediately from the fixed
 * image.runpod.ai host and store the image itself as a private inline asset.
 */
export async function generateRunpodImage(prompt: string, deps: {
  fetchFn?: typeof fetch;
  apiKey?: string;
} = {}): Promise<ProviderResponse> {
  const apiKey = deps.apiKey ?? process.env.RUNPOD_API_KEY ?? "";
  if (!apiKey) throw new Error("RunPod API key is not configured.");
  if (!prompt.trim() || prompt.length > 10000) throw new Error("Invalid RunPod image prompt.");
  const fetchFn = deps.fetchFn ?? fetch;
  const response = await fetchFn(
    `https://api.runpod.ai/v2/${RUNPOD_IMAGE_MODEL_ID}/runsync`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ input: { prompt, width: 1024, height: 1024 } }),
      signal: AbortSignal.timeout(135000),
      cache: "no-store",
      redirect: "error",
    },
  );
  if (!response.ok) throw new Error(`RunPod public image endpoint failed (HTTP ${response.status}).`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") throw new Error("Invalid RunPod image response.");
  const result = payload as { status?: unknown; output?: { image_url?: unknown } };
  if (result.status !== "COMPLETED") throw new Error("RunPod public image generation did not complete.");

  // Fetch the expiring CDN image with no auth headers, credentials or redirects.
  const safeUrl = checkedImageUrl(result.output?.image_url);
  const imageResponse = await fetchFn(safeUrl, {
    method: "GET", redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  const image = await collectImageBytes(imageResponse);
  const mime = mimeFromImage(image);
  return {
    text: "[Image Generated]",
    provider: "runpod" as ProviderResponse["provider"],
    model: RUNPOD_IMAGE_MODEL_ID,
    content: [{ type: "image", url: `data:${mime};base64,${image.toString("base64")}` }],
  };
}
