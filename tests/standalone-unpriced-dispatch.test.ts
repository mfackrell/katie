import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { blockUnaccountedPaidDispatch } from "../lib/standalone-accounting/unsupported";
import { runWithStandaloneAccounting } from "../lib/standalone-accounting/context";
import { generateRunpodImage } from "../lib/chat/runpod-image-fallback";
import { describeImageWithRunpodQwen } from "../lib/chat/runpod-still-vision";
import { submitSavedVideo } from "../lib/runpod/durable-results";
import { buildFileReferences } from "../lib/uploads/build-file-references";
import { describeAttachmentEvidence } from "../lib/uploads/attachment-observations";
import { OpenAIEmbeddingProvider } from "../packages/indexer/src/embeddings";

// These tests never mock the production admission guard. The separate RunPod
// protocol suites replace it only inside their own scoped fake-HTTP fixtures.
const blocked = { code: "standalone_unsupported_billing", terminal: true };
const chatId = "12345678-1234-1234-1234-123456789abc";

function fixtureEnv(t: TestContext, values: Record<string, string>): void {
  const prior = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("the real unsupported-billing guard is terminal", () => {
  assert.throws(() => blockUnaccountedPaidDispatch("unpriced test operation"), blocked);
});

test("real RunPod image admission blocks before its injected or global HTTP transport", async t => {
  let sends = 0;
  const noSend: typeof fetch = async () => { sends++; throw new Error("Unexpected provider HTTP send"); };
  t.mock.method(globalThis, "fetch", noSend);
  await assert.rejects(generateRunpodImage("A lighthouse", { apiKey: "fixture-runpod-key", fetchFn: noSend }), blocked);
  assert.equal(sends, 0);
});

test("real RunPod still-image admission blocks valid pixels before HTTP", async t => {
  fixtureEnv(t, { RUNPOD_API_KEY: "fixture-runpod-key" });
  let sends = 0;
  const noSend: typeof fetch = async () => { sends++; throw new Error("Unexpected provider HTTP send"); };
  t.mock.method(globalThis, "fetch", noSend);
  await assert.rejects(describeImageWithRunpodQwen("data:image/jpeg;base64,QUJDRA==", "Describe the photo", { fetchFn: noSend }), blocked);
  assert.equal(sends, 0);
});

test("real durable RunPod video admission never sends the paid POST", async t => {
  fixtureEnv(t, { RUNPOD_API_KEY: "fixture-runpod-key", SUPABASE_URL: "https://persistence.invalid", SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key" });
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => { sends++; throw new Error("Unexpected provider or persistence HTTP send"); });
  await assert.rejects(submitSavedVideo({ chatId, attachmentPath: `chats/${chatId}/${chatId}.source`, question: "Describe this video" }), blocked);
  assert.equal(sends, 0, "Unsupported video dispatch is rejected before creating a submission receipt");
});

test("native Google and OpenAI upload preprocessing cannot send unsupported storage requests", async t => {
  fixtureEnv(t, { OPENAI_API_KEY: "fixture-openai-key", GOOGLE_API_KEY: "fixture-google-key" });
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => { sends++; throw new Error("Unexpected upload HTTP send"); });
  const result = await runWithStandaloneAccounting({ userId: "owner", actorId: "actor", chatId: "chat", requestId: "blocked-uploads" },
    () => buildFileReferences([new File(["fixture-video-bytes"], "fixture.mp4", { type: "video/mp4" })]));
  assert.equal(result.length, 1);
  assert.equal(result[0].attachmentKind, "video");
  assert.equal(result[0].providerRef, undefined, "Blocked provider uploads cannot create a native file reference");
  assert.equal(sends, 0);
});

test("Google native-video observation blocks unsupported billing before generation", async t => {
  fixtureEnv(t, { GOOGLE_API_KEY: "fixture-google-key" });
  const priorDatabase = globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__;
  const ledgerCalls: string[] = [];
  globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__ = { rpc: async (name: string) => {
    ledgerCalls.push(name);
    if (name === "standalone_register_pricing") return { data: true, error: null };
    if (name === "standalone_lookup_attempt") return { data: null, error: null };
    assert.fail(`Unsupported native video must not be admitted: ${name}`);
  } } as unknown as NonNullable<typeof globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__>;
  t.after(() => { globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__ = priorDatabase; });
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => { sends++; throw new Error("Unexpected preprocessing HTTP send"); });
  await assert.rejects(runWithStandaloneAccounting({ userId: "owner", actorId: "actor", chatId: "chat", requestId: "blocked-observation" },
    () => describeAttachmentEvidence({ fileId: "fixture", fileName: "fixture.mp4", mimeType: "video/mp4", preview: "Fixture video", providerRef: { googleFileUri: "https://generativelanguage.googleapis.com/v1beta/files/fixture" } })),
  { code: "standalone_unsupported_billing" });
  assert.equal(sends, 0);
  assert.deepEqual(ledgerCalls, ["standalone_register_pricing", "standalone_lookup_attempt"]);
});

test("the real indexer embedding guard blocks before the SDK can transmit", async t => {
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => { sends++; throw new Error("Unexpected embedding HTTP send"); });
  const embedder = new OpenAIEmbeddingProvider("fixture-openai-key", "text-embedding-3-small");
  await assert.rejects(embedder.embed(["Fixture text"]), blocked);
  assert.equal(sends, 0);
});
