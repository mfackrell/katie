import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isTechnicalImageFailure, shouldTryRunpodImage, generateRunpodImage,
} from "../lib/chat/runpod-image-fallback";

const grok = { provider: "grok" as const, error: "xAI request timed out" };
const google = { provider: "google" as const, error: "Gemini response HTTP 503 Service Unavailable" };

test("RunPod image fallback requires BOTH Grok and Gemini technical failures", () => {
  assert.equal(shouldTryRunpodImage({ failures: [grok, google], enabled: true, hasReferenceImages: false }), true);
  assert.equal(shouldTryRunpodImage({ failures: [grok], enabled: true, hasReferenceImages: false }), false);
  assert.equal(shouldTryRunpodImage({ failures: [google], enabled: true, hasReferenceImages: false }), false);
  assert.equal(shouldTryRunpodImage({ failures: [grok, google], enabled: false, hasReferenceImages: false }), false);
  assert.equal(shouldTryRunpodImage({ failures: [grok, google], enabled: true, hasReferenceImages: true }), false);
});

test("Content refusals never qualify as failures eligible for another image provider", () => {
  const content = [
    'xAI Images API failed (400 Bad Request): {"code":"imagine:content-moderated"}',
    "Google stopped this response (PROHIBITED_CONTENT)",
    "Google blocked request for SAFETY",
    "Content moderation policy refusal",
  ];
  for (const error of content) {
    assert.equal(isTechnicalImageFailure(error), false, error);
    assert.equal(shouldTryRunpodImage({
      failures: [{ provider: "grok", error }, google],
      enabled: true, hasReferenceImages: false,
    }), false, error);
    assert.equal(shouldTryRunpodImage({
      failures: [grok, { provider: "google", error }],
      enabled: true, hasReferenceImages: false,
    }), false, error);
  }
  assert.equal(isTechnicalImageFailure(new Error("upstream 429 rate limit")), true);
  assert.equal(isTechnicalImageFailure("provider permission denied"), false);
  assert.equal(isTechnicalImageFailure("model returned an empty image"), false);
  // Non-policy generation failures are eligible even if they are not transport failures.
  assert.equal(shouldTryRunpodImage({
    failures: [{ provider: "grok", error: "model returned an empty image" },
      { provider: "google", error: "output limit exceeded" }],
    enabled: true, hasReferenceImages: false,
  }), true);
});

test("RunPod image API returns a verified inline image, using only fixed RunPod host", async () => {
  // Valid 1x1 png, no remote URLs are ever fetched or displayed as memory anchors.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7pkAAAAASUVORK5CYII=";
  let requests = 0;
  const answer = await generateRunpodImage("A lighthouse", {
    endpointId: "image-test-endpoint", apiKey: "test-key",
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
      requests++;
      assert.equal(String(url), "https://api.runpod.ai/v2/image-test-endpoint/runsync?wait=120000");
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string,string>)?.Authorization, "Bearer test-key");
      assert.deepEqual(JSON.parse(String(init?.body)), { input: { prompt: "A lighthouse" } });
      return new Response(JSON.stringify({ status: "COMPLETED", output: {
        images: [{ type: "base64", data: png }],
      } }), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(requests, 1);
  assert.equal(answer.provider, "runpod");
  assert.equal(answer.text, "[Image Generated]");
  assert.equal(answer.content?.[0]?.type, "image");
  assert.equal(answer.content?.[0]?.url, "data:image/png;base64," + png);
});

test("RunPod refuses unsupported output formats and wrong worker contracts", async () => {
  await assert.rejects(generateRunpodImage("A lighthouse", {
    endpointId: "test-worker", apiKey: "test-key",
    fetchFn: (async () => new Response(JSON.stringify({
      status: "COMPLETED", output: { image_url: "https://example.com/remote-image.png" },
    }), { status: 200 })) as typeof fetch,
  }), /missing or unsupported/);
  await assert.rejects(generateRunpodImage("A lighthouse", {
    endpointId: "../host", apiKey: "test-key", fetchFn: (async () => {
      throw new Error("Should not make a request");
    }) as typeof fetch,
  }), /not configured/);
});

test("Chat integration is optional and never routes RunPod through the video analysis shortcut", () => {
  const route = readFileSync("app/api/chat/route.ts", "utf8");
  assert.match(route, /if \(candidate\.runpodImageFallback\)/);
  assert.match(route, /shouldTryRunpodImage\(\{/);
  assert.match(route, /if \(attempt\.runpodImageFallback\) return null/);
  assert.match(route, /generateRunpodImage\(/);
});
