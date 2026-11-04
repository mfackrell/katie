import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the real attachment-observation module with no provider, storage,
// database, credential or paid calls. Image bytes must reach the vision
// provider before Katie can claim a source-bound visual episode.
const source = readFileSync("lib/uploads/attachment-observations.ts", "utf8");
const js = ts.transpileModule(source, {
  fileName: "attachment-observations.ts",
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    esModuleInterop: true },
}).outputText;
const imageDataUrl = "data:image/png;base64,YWJj";
const expectedHash = createHash("sha256").update(imageDataUrl).digest("hex");
const image = data => ({
  fileId: "image-1", fileName: "screenshot.png", mimeType: "image/png",
  preview: "image", imageDataUrl: data,
});
function harness({ googleResult = { text: "A blue bicycle on a sidewalk." },
  grokResult = "The photo contains a visible red bicycle." } = {}) {
  const calls = [];
  const exports = {};
  class GrokProvider {
    async listModels() { return ["grok-4.7"]; }
    async generate(params) { calls.push({ provider: "grok", params });
      return { model: "grok-4.7", text: grokResult }; }
  }
  const mocks = {
    "@/lib/standalone-accounting/context": {
      getAccountingScope: () => null,
      runWithStandaloneActivity: async (_scope, fn) => fn(),
      isStandaloneAccountingError: () => false,
    },
    "./still-image-observations": {
      observeStandaloneStillImages: async () => { throw Error("Unexpected standalone Qwen dispatch"); },
      imageObservationHash: input => createHash("sha256").update(input).digest("hex"),
    },
    "@/lib/providers/google-transport": {
      googleGenerateContent: async (_key, request) => {
        calls.push({ provider: "google", request });
        return googleResult;
      },
    },
    "@/lib/providers/grok-provider": { GrokProvider },
    "@/lib/chat/vision-refusal-fallback": { selectGrokVisionFallback: () => "grok-4.7" },
  };
  runInNewContext(js, {
    exports,
    require(name) { assert.ok(name in mocks, "Unexpected import: " + name); return mocks[name]; },
    process: { env: { GOOGLE_API_KEY: "test-only", GROK_API_KEY: "test-only" } },
    console: { warn() {} },
    Date,
  }, { filename: "attachment-observations.js" });
  return { describe: exports.describeAttachmentEvidence, calls };
}

test("Gemini image inspection stamps the exact pixels passed to the vision model", async () => {
  const h = harness();
  const descriptor = await h.describe(image(imageDataUrl));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].provider, "google");
  assert.ok(h.calls[0].request.contents[0].parts.some(part => "inlineData" in part));
  assert.equal(descriptor.observationSourceHash, expectedHash);
  assert.equal(descriptor.summaryModel, "gemini-2.5-flash");
  assert.ok(!Number.isNaN(Date.parse(descriptor.observationAt)));
});

test("invalid or unavailable image pixels cannot become Katie's first-person visual memory", async () => {
  for (const data of ["not-an-image", "data:image/png;invalid,abc", undefined]) {
    const h = harness();
    const descriptor = await h.describe(image(data));
    assert.equal(h.calls.length, 0, "Do not pay a text-only provider to imagine pixels");
    assert.equal(descriptor.summaryCoverage, "metadata");
    assert.equal(descriptor.summaryModel, "source-excerpt");
    assert.equal(descriptor.observationSourceHash, undefined);
  }
});

test("real image supplied to Grok vision fallback is source-bound; refusal without pixels is not", async () => {
  const h = harness({ googleResult: { promptFeedback: { blockReason: "OTHER" } } });
  const descriptor = await h.describe(image(imageDataUrl));
  assert.deepEqual(h.calls.map(call => call.provider), ["google", "grok"]);
  // vm.runInNewContext gives arrays a different realm/prototype. Check the
  // actual image payload rather than comparing cross-realm array identities.
  assert.equal(h.calls[1].params.images?.length, 1);
  assert.equal(h.calls[1].params.images[0], imageDataUrl);
  assert.equal(descriptor.summaryModel, "grok-4.7");
  assert.equal(descriptor.observationSourceHash, expectedHash);
});
