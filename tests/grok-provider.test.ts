import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { GrokProvider } from "../lib/providers/grok-provider";
import type { ChatGenerateParams } from "../lib/providers/types";

const params: ChatGenerateParams = {
  name: "Katie", persona: "Be helpful.", summary: "Private unrelated memory", history: [],
  user: "Generate an illustration of a cat watching a sunset.", requestIntent: "image-generation", modelId: "grok-imagine-image-2.0",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function mockFetch(t: TestContext, response: Response) {
  const requests: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init, body: JSON.parse(String(init?.body ?? "{}")) });
    return response;
  });
  return requests;
}

test("Grok image models use images/generations and return displayable persistable base64 assets", async (t) => {
  const requests = mockFetch(t, json({ data: [{ b64_json: "aW1hZ2U=", mime_type: "image/png" }] }));
  const result = await new GrokProvider("test-key").generate(params);
  assert.equal(requests.length, 1, "no model discovery or chat completion round trip");
  assert.equal(requests[0].url, "https://api.x.ai/v1/images/generations");
  assert.equal(new Headers(requests[0].init?.headers).get("authorization"), "Bearer test-key");
  assert.deepEqual(requests[0].body, { model: params.modelId, prompt: params.user, n: 1, response_format: "b64_json" });
  assert.equal(result.model, params.modelId);
  assert.equal(result.provider, "grok");
  assert.equal(result.text, "[Image Generated]");
  assert.deepEqual(result.content, [{ type: "image", url: "data:image/png;base64,aW1hZ2U=" }]);
  assert.doesNotMatch(JSON.stringify(requests[0].body), /Private unrelated memory|messages|tools/);
});

test("Grok image aliases and quality models never fall back to grok-2 text generation", async (t) => {
  for (const model of ["grok-imagine", "grok-imagine-image", "grok-imagine-image-quality"]) {
    const requests = mockFetch(t, json({ data: [{ b64_json: "aW1hZ2U=" }] }));
    const result = await new GrokProvider("test-key").generate({ ...params, modelId: model });
    assert.equal(requests[0].body.model, model === "grok-imagine" ? "grok-imagine-image" : model);
    assert.equal(result.content?.[0].url, "data:image/jpeg;base64,aW1hZ2U=");
    t.mock.restoreAll();
  }
});

test("Grok image edits use JSON edits endpoint and preserve one or multiple source images", async (t) => {
  for (const images of [["data:image/png;base64,aW1hZ2U="], ["https://example.com/cat.png", "https://example.com/hat.png"]]) {
    const requests = mockFetch(t, json({ data: [{ b64_json: "aW1hZ2U=" }] }));
    await new GrokProvider("test-key").generate({ ...params, user: "Add a blue hat.", images });
    assert.equal(requests[0].url, "https://api.x.ai/v1/images/edits");
    assert.equal(new Headers(requests[0].init?.headers).get("content-type"), "application/json");
    assert.deepEqual(images.length === 1 ? [requests[0].body.image] : requests[0].body.images, images.map(url => ({ type: "image_url", url })));
    t.mock.restoreAll();
  }
});

test("Grok preserves URL image responses and rejects empty or malformed image success responses", async (t) => {
  const requests = mockFetch(t, json({ data: [{ url: "https://imgen.x.ai/example.jpeg" }] }));
  const result = await new GrokProvider("test-key").generate(params);
  assert.equal(requests.length, 1);
  assert.deepEqual(result.content, [{ type: "image", url: "https://imgen.x.ai/example.jpeg" }]);
  t.mock.restoreAll();
  for (const payload of [{}, { data: [] }, { data: [{ revised_prompt: "Only text" }] }, { data: [{ b64_json: "not valid base64!!!" }] }]) {
    mockFetch(t, json(payload));
    await assert.rejects(new GrokProvider("test-key").generate(params), /no (?:usable )?image/);
    t.mock.restoreAll();
  }
});

test("Grok image API failures propagate for provider fallback without retrying chat completion", async (t) => {
  const requests = mockFetch(t, json({ error: "model unavailable" }, 404));
  await assert.rejects(new GrokProvider("test-key").generate(params), /Grok image request failed.*404.*model unavailable/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.x.ai/v1/images/generations");
});

test("Grok rejects image tasks with a text model and excessive edit inputs before dispatch", async (t) => {
  const requests = mockFetch(t, json({}));
  await assert.rejects(new GrokProvider("test-key").generate({ ...params, modelId: "grok-4.7" }), /requires an image model/);
  await assert.rejects(new GrokProvider("test-key").generate({ ...params, images: Array(6).fill("https://example.com/cat.png") }), /up to five/);
  assert.equal(requests.length, 0);
});

test("Grok text chat and web research retain their existing endpoints", async (t) => {
  for (const intent of ["general-text", "web-search"]) {
    const urls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url);
      if (url.endsWith("/models")) return json({ data: [{ id: "grok-4.7" }] });
      if (url.endsWith("/responses")) return json({ output_text: "Verified evidence", citations: ["https://example.com/"] });
      return json({ choices: [{ message: { content: "Text answer" } }] });
    });
    const result = await new GrokProvider("test-key").generate({ ...params, modelId: "grok-4.7", requestIntent: intent });
    assert.equal(urls[1], intent === "web-search" ? "https://api.x.ai/v1/responses" : "https://api.x.ai/v1/chat/completions");
    assert.equal(result.text, intent === "web-search" ? "Verified evidence" : "Text answer");
    if (intent === "web-search") assert.equal(result.researchEvidence?.sources[0].url, "https://example.com/");
    t.mock.restoreAll();
  }
});
