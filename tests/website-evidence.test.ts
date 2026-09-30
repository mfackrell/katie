import test from "node:test";
import assert from "node:assert/strict";
import { collectWebsiteEvidence, isPublicAddress, launchWebsiteBrowser, validateWebsiteUrl, websiteReviewUrls } from "../lib/research/website-evidence";
import { formatResearchEvidence, mergeResearchEvidence, websiteImages } from "../lib/research/shared-evidence";
import { runAdaptiveCollaboration } from "../lib/collaboration/orchestrator";
import { runOnDemandCapabilityEscalation } from "../lib/collaboration/capability-escalation-runner";
import { CAPABILITY_REQUEST_PREFIX } from "../lib/collaboration/capability-escalation";
import type { ChatGenerateParams, LlmProvider, WebsiteEvidence } from "../lib/providers/types";

const params: ChatGenerateParams = {
  name: "Katie", persona: "Be precise", summary: "", history: [],
  user: "Review this website https://example.com/", requestIntent: "marketing-analysis", secondaryIntents: ["web-search"],
};
const screenshot = "data:image/jpeg;base64,c2NyZWVuc2hvdA==";
const website: WebsiteEvidence = {
  capturedAt: "2026-09-30T19:00:00Z", limitations: [],
  pages: [{
    requestedUrl: "https://example.com/", url: "https://example.com/", title: "Example", status: 200,
    html: "<h1>Example</h1>", htmlTruncated: false,
    stylesheets: [{ url: "https://example.com/style.css", css: "h1{color:#ff0000}", truncated: false }],
    views: [{
      device: "desktop", viewport: { width: 1440, height: 900 },
      document: { width: 1440, height: 1800, horizontalOverflow: false }, text: "Example",
      elements: [{ tag: "h1", text: "Example", bounds: { x: 0, y: 0, width: 500, height: 60 }, styles: { color: "rgb(255, 0, 0)", "font-size": "48px" } }],
      images: [], screenshot: { dataUrl: screenshot, width: 1440, height: 1800, truncated: false }, limitations: [],
    }], limitations: [],
  }],
};

test("website review URL detection includes follow-ups but leaves ordinary searches alone", () => {
  assert.deepEqual(websiteReviewUrls(params), ["https://example.com/"]);
  assert.deepEqual(websiteReviewUrls({ ...params, user: "Search current news https://example.com/", requestIntent: "news-summary" }), []);
  assert.deepEqual(websiteReviewUrls({ ...params, user: "Review the site again", history: [{ role: "user", content: "https://example.com/" }] }), ["https://example.com/"]);
  assert.deepEqual(websiteReviewUrls({ ...params, user: "Review https://example.com/report.pdf" }), []);
});

test("browser fetch guard blocks private addresses, credentials and unsafe protocols", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  for (const url of ["http://127.0.0.1", "http://[::1]", "http://169.254.169.254", "file:///tmp/secret", "https://user:password@example.com/", "https://example.com:8080/"]) {
    await assert.rejects(validateWebsiteUrl(url), undefined, url);
  }
});

test("shared packet retains the complete retriever output and sends image bytes separately", () => {
  const tail = "DESIGN_TAIL_AFTER_28K";
  const output = "e".repeat(28_000) + tail;
  const evidence = mergeResearchEvidence({ text: output }, { provider: "grok", modelId: "web" }, params.user, website);
  const formatted = formatResearchEvidence(evidence);
  assert.ok(formatted.includes(output));
  assert.match(formatted, /font-size/);
  assert.match(formatted, /style.css/);
  assert.match(formatted, /imageIndex/);
  assert.ok(!formatted.includes(screenshot));
  assert.deepEqual(websiteImages(evidence.website), [screenshot]);
  assert.equal(evidence.sources[0]?.url, "https://example.com/");
});

test("all reviewers and replacement synthesis receive the full research tail, CSS and screenshots", async () => {
  const tail = "DESIGN_FINDING_BEYOND_OLD_LIMIT";
  const output = "Observed site text. ".repeat(1800) + tail;
  const calls = new Map<string, ChatGenerateParams[]>();
  const provider = (name: LlmProvider["name"], answer: string): LlmProvider => ({
    name,
    async listModels() { return [name]; },
    async generate(p) {
      calls.set(name, [...(calls.get(name) ?? []), p]);
      return { provider: name, model: name, text: answer };
    },
  });
  const lead = provider("anthropic", '{"action":"ready","synthesisBrief":"Use all evidence."}');
  lead.generateStream = async () => { throw new Error("Replace lead for test"); };
  const research = provider("grok", output);
  const critique = provider("openai", '{"action":"answer","answer":"Use better contrast."}');
  const replacement = provider("google", "Final review.");
  let captures = 0;
  const result = await runAdaptiveCollaboration({
    requestId: "full-design-evidence", params, leadProvider: lead, leadModelId: "lead",
    providers: [lead, research, critique, replacement],
    maxContributionChars: 1000, maxTotalContributionChars: 2000,
    collectWebsiteEvidence: async () => { captures++; return website; },
    async selectHelper(context) {
      if (context.request.capability === "research") return { provider: research, modelId: "web" };
      assert.equal(context.hasImages, true);
      return { provider: critique, modelId: "critic" };
    },
    async selectReplacementLead() { return { provider: replacement, modelId: "replacement" }; },
  });
  assert.equal(captures, 1);
  for (const name of ["anthropic", "openai", "google"]) {
    const p = calls.get(name)?.at(-1);
    assert.ok(p?.user.includes(tail), name + " lost research tail");
    assert.match(p?.user ?? "", /font-size/);
    assert.deepEqual(p?.images, [screenshot]);
  }
  assert.equal(result.result.researchEvidence?.summary, output);
  assert.match(result.trace.find((event) => event.type === "research_evidence_collected")?.detail ?? "", /screenshots=1/);
});

test("on-demand research preserves full evidence and screenshot delivery to the lead", async () => {
  let pass = 0;
  let final: ChatGenerateParams | undefined;
  const lead: LlmProvider = {
    name: "anthropic", async listModels() { return ["lead"]; },
    async generate(p) {
      pass++;
      final = p;
      return { provider: "anthropic", model: "lead", text: pass === 1
        ? CAPABILITY_REQUEST_PREFIX + ' {"capability":"research","task":"Inspect the website https://example.com/"}'
        : "Final website review." };
    },
  };
  const tail = "ON_DEMAND_DESIGN_TAIL";
  const helper: LlmProvider = {
    name: "grok", async listModels() { return ["web"]; },
    async generate() { return { provider: "grok", model: "web", text: "x".repeat(28_000) + tail }; },
  };
  await runOnDemandCapabilityEscalation({
    requestId: "on-demand-design", params, leadProvider: lead, leadModelId: "lead",
    collectWebsiteEvidence: async () => website,
    async selectHelper() { return { provider: helper, modelId: "web" }; },
    onFinalTextDelta() {},
  });
  assert.ok(final?.user.includes(tail));
  assert.match(final?.user ?? "", /style.css/);
  assert.deepEqual(final?.images, [screenshot]);
});

test("browser launch failure becomes an explicit coverage limitation", async () => {
  const evidence = await collectWebsiteEvidence(params, { launch: async () => { throw new Error("native browser unavailable"); } });
  assert.equal(evidence?.pages.length, 0);
  assert.match(evidence?.limitations.join("\n") ?? "", /native browser unavailable/);
});

test("real Chromium captures applied desktop/mobile CSS, HTML and screenshots", { timeout: 60_000 }, async () => {
  const browser = await launchWebsiteBrowser();
  const actualNewContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await actualNewContext(options);
    const actualRoute = context.route.bind(context);
    // Production route validation still runs; fixture responses replace network access.
    context.route = async (_pattern, handler) => {
      await actualRoute("**/*", async (route, request) => {
        const proxy = new Proxy(route, {
          get(target, key) {
            if (key === "continue") return async () => {
              if (request.url().endsWith("/style.css")) {
                await target.fulfill({ contentType: "text/css", body: "body{margin:0;background:#f0f0f0} h1{font-family:Arial;font-size:48px;color:#ff0000} @media(max-width:600px){h1{font-size:24px}}" });
              } else {
                await target.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><title>Fixture</title><link rel="stylesheet" href="/style.css"></head><body><header><nav><a href="/team">Team</a></nav></header><main><h1>Rendered fixture</h1><button>Contact us</button></main></body></html>' });
              }
            };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        if (typeof handler === "function") await handler(proxy, request);
      });
    };
    return context;
  };
  const evidence = await collectWebsiteEvidence(params, {
    launch: async () => browser, validate: async () => {}, timeoutMs: 45_000,
  });
  assert.ok(evidence?.pages.length);
  const page = evidence.pages[0];
  assert.equal(page.title, "Fixture");
  assert.match(page.html, /stylesheet/);
  assert.ok(page.stylesheets.some((sheet) => sheet.css.includes("@media")));
  assert.equal(page.views.length, 2, JSON.stringify(page.limitations));
  assert.equal(page.views[0].elements.find((node) => node.tag === "h1")?.styles["font-size"], "48px");
  assert.equal(page.views[1].elements.find((node) => node.tag === "h1")?.styles["font-size"], "24px");
  assert.equal(websiteImages(evidence).length, evidence.pages.length * 2);
  assert.equal(browser.isConnected(), false);
});
