import type { ProviderResponse } from "@/lib/providers/types";

/**
 * RunPod is a technical-resilience fallback, never a content-refusal bypass.
 * Caller must have observed failures from BOTH Grok and Google in this request.
 */
export type ImageProviderFailure = { provider: "grok" | "google"; error: string };

const MODERATION = /prohibited[_ -]?content|content[_ -]?moderat|moderation|\bsafety\b|\bpolicy\b|\brefus(?:al|ed)\b|\bnsfw\b|\bblocked\b|\bdisallowed\b|\binappropriate\b/i;
const TECHNICAL = /(?:\b429\b|\b50[0-9]\b|\b52[0-9]\b|\b503\b|\b504\b|rate.?limit|too many requests|timeout|timed out|overload|temporar(?:ily|y)|econnreset|econnrefused|etimedout|fetch failed|network error|service unavailable|gateway timeout|connection (?:lost|reset|failed))/i;

export function isTechnicalImageFailure(error: unknown): boolean {
  const value = error instanceof Error ? error.message : String(error ?? "");
  return !MODERATION.test(value) && TECHNICAL.test(value);
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
  return input.failures.some(f => f.provider === "grok" && isTechnicalImageFailure(f.error)) &&
    input.failures.some(f => f.provider === "google" && isTechnicalImageFailure(f.error));
}

export function runpodImageConfigured(): boolean {
  return Boolean(process.env.RUNPOD_API_KEY && /^[a-zA-Z0-9_-]{3,80}$/.test(process.env.RUNPOD_IMAGE_ENDPOINT_ID ?? ""));
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ENDPOINT_RE = /^[a-zA-Z0-9_-]{3,80}$/;

/**
 * The configured RunPod image worker must accept {"input":{"prompt":...}}
 * and return the ComfyUI-style {"status":"COMPLETED","output":{"images":
 * [{"type":"base64","data":"..."}]}} response. No untrusted URL downloads.
 * This requires a separately provisioned image-generation worker.
 */
export async function generateRunpodImage(prompt: string, deps: {
  fetchFn?: typeof fetch;
  endpointId?: string;
  apiKey?: string;
} = {}): Promise<ProviderResponse> {
  const endpointId = deps.endpointId ?? process.env.RUNPOD_IMAGE_ENDPOINT_ID ?? "";
  const apiKey = deps.apiKey ?? process.env.RUNPOD_API_KEY ?? "";
  if (!ENDPOINT_RE.test(endpointId) || !apiKey) {
    throw new Error("RunPod image endpoint is not configured.");
  }
  if (!prompt.trim() || prompt.length > 10000) {
    throw new Error("Invalid RunPod image prompt.");
  }

  const response = await (deps.fetchFn ?? fetch)(
    `https://api.runpod.ai/v2/${endpointId}/runsync?wait=120000`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ input: { prompt } }),
      signal: AbortSignal.timeout(135000),
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error(`RunPod image endpoint failed (HTTP ${response.status}).`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") throw new Error("Invalid RunPod image response.");
  const body = payload as { status?: unknown; output?: { images?: Array<{ type?: unknown; data?: unknown }> } };
  if (body.status !== "COMPLETED") throw new Error("RunPod image generation did not complete.");

  const first = body.output?.images?.[0];
  if (first?.type !== "base64" || typeof first.data !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(first.data) || first.data.length > MAX_IMAGE_BYTES * 4 / 3 + 4) {
    throw new Error("RunPod image output is missing or unsupported.");
  }
  const decoded = Buffer.from(first.data, "base64");
  if (decoded.length < 16 || decoded.length > MAX_IMAGE_BYTES) {
    throw new Error("Invalid RunPod image size.");
  }
  const mime = decoded.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    ? "image/png"
    : decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff
      ? "image/jpeg"
      : decoded.toString("ascii", 0, 4) === "RIFF" && decoded.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp" : "";
  if (!mime) throw new Error("RunPod returned an unsupported image format.");

  return {
    text: "[Image Generated]",
    provider: "runpod" as ProviderResponse["provider"],
    model: `runpod-image:${endpointId}`,
    content: [{ type: "image", url: `data:${mime};base64,${first.data}` }],
  };
}
