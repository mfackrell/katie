import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { collectWebsiteEvidence, launchWebsiteBrowser } from "../lib/research/website-evidence";
import { captureVisualReview, compareWebsiteReviews } from "../lib/research/visual-review";
import { formatWebsiteEvidence, websiteImages, browserResearchEvidence } from "../lib/research/shared-evidence";
import { createWebsiteEvidenceStore } from "../lib/research/stored-evidence";
import { runAdaptiveCollaboration } from "../lib/collaboration/orchestrator";
import type { LlmProvider } from "../lib/providers/types";
import type { ChatGenerateParams, WebsiteEvidence } from "../lib/providers/types";

const params: ChatGenerateParams = { name: "Katie", persona: "", summary: "", history: [], requestIntent: "marketing-analysis", secondaryIntents: ["web-search"], user: "Review https://example.com/ preserving the full service positioning" };
const html = (body: string, css = "") => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:18px Arial}*{box-sizing:border-box}${css}</style><h1>Full service company</h1>${body}`;
async function capture(body: string, css = "", extra: Parameters<typeof collectWebsiteEvidence>[1] = {}, previous?: WebsiteEvidence) {
  const browser = await launchWebsiteBrowser();
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async options => {
    const context = await newContext(options);
    const route = context.route.bind(context);
    context.route = async (_pattern, handler) => route("**/*", async (r, req) => {
      const proxy = new Proxy(r, { get(target, key) {
        if (key === "continue") return async () => target.fulfill({ status: req.url().endsWith("missing.png") ? 404 : 200, contentType: "text/html", body: html(body, css) });
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      }});
      if (typeof handler === "function") await handler(proxy, req);
    });
    return context;
  };
  const result = await collectWebsiteEvidence({ ...params, previousWebsiteEvidence: previous }, { launch: async () => browser, validate: async () => {}, ...extra });
  assert.ok(result);
  return result;
}
const reviews = (e: WebsiteEvidence) => e.pages.flatMap(p => p.views.map(v => v.visualReview!));
const findings = (e: WebsiteEvidence) => reviews(e).flatMap(v => v.frames.flatMap(f => f.findings));

test("Katie captures below 4500px, sends every indexed tile, and verifies genuine repairs", { timeout: 60000 }, async () => {
  const body = '<div style="height:5000px"></div><p id="issue">Preserve the entire service offer and all of this text.</p><footer>End</footer>';
  const before = await capture(body, '#issue{width:120px;height:20px;overflow:hidden}');
  assert.ok(reviews(before).every(v => v.status === "complete"));
  assert.ok(findings(before).some(f => f.rule === "clipped-text" && f.selector === "#issue"));
  assert.ok(reviews(before).every(v => v.coveredHeight >= v.documentHeight));
  const formatted = formatWebsiteEvidence(before), images = websiteImages(before);
  assert.ok(images.length > 10);
  assert.equal((formatted.match(/"imageIndex":/g) ?? []).length, images.length);
  assert.ok(!formatted.includes("base64,"));
  let index = 0;
  for (const v of reviews(before)) for (const f of v.frames) {
    assert.equal(images[index++], f.screenshot.dataUrl);
    assert.equal(createHash("sha256").update(Buffer.from(f.screenshot.dataUrl.split(",")[1], "base64")).digest("hex"), f.screenshotHash);
  }
  const after = await capture(body, '#issue{width:100%;height:auto}', {}, before);
  assert.ok(after.comparisons?.every(c => c.issues.some(i => i.id === "clipped-text:#issue" && i.status === "resolved")));
  assert.match(formatted, /preserving the full service positioning/);
});

test("deletion, replacement, missing states and partial coverage never certify repairs", { timeout: 60000 }, async () => {
  const before = await capture('<p id="issue">Original offer</p>', '#issue{width:30px;height:10px;overflow:hidden}');
  const removed = await capture('<p id="other">Other</p>');
  assert.ok(compareWebsiteReviews(before, removed).every(c => c.issues[0].status === "target_missing_or_outside_capture"));
  const replaced = await capture('<p id="issue">Different positioning</p>');
  assert.ok(compareWebsiteReviews(before, replaced).every(c => c.issues[0].status === "target_changed"));
  reviews(replaced).forEach(v => v.status = "partial");
  assert.ok(compareWebsiteReviews(before, replaced).every(c => c.issues[0].status === "unverified"));
  reviews(replaced).forEach(v => { v.status = "complete"; v.frames[0].screenshotHash = "corrupt"; });
  assert.ok(compareWebsiteReviews(before, replaced).every(c => c.issues[0].status === "unverified"));
  replaced.pages[0].views = [];
  assert.ok(compareWebsiteReviews(before, replaced).every(c => c.status === "unverified"));
});

test("fixed-header scroll artifacts are removed, genuine covered controls remain", { timeout: 60000 }, async () => {
  const result = await capture('<header>Header</header><div style="height:760px"></div><button id="scroll">Contact</button><div style="height:1000px"></div><button id="covered">Contact</button><div id="cover"></div>', 'header{position:fixed;top:0;height:150px;background:white;width:100%;z-index:4}#cover{position:absolute;bottom:0;width:100%;height:30px;background:white;z-index:5}body{position:relative}');
  assert.ok(!findings(result).some(f => f.rule === "occluded-control" && f.selector === "#scroll"));
  assert.ok(findings(result).some(f => f.rule === "occluded-control" && f.selector === "#covered"));
});

test("explicit disclosure states run in separate contexts and writes are blocked", { timeout: 60000 }, async () => {
  const result = await capture('<button id="menu" aria-controls="items" onclick="document.getElementById(\'items\').hidden=false;fetch(\'/write\',{method:\'POST\'})">Menu</button><p id="items" hidden>Menu content</p>', '', { states: [{ name: "menu-open", selector: "#menu", expectVisible: "#items" }] });
  assert.equal(result.pages[0].views.length, 4);
  assert.equal(reviews(result).filter(v => v.state === "menu-open").length, 2);
  assert.ok(reviews(result).filter(v => v.state === "menu-open").every(v => v.status === "partial"));
  assert.ok(reviews(result).filter(v => v.state === "default").every(v => !v.frames.flatMap(f => f.elements).some(e => e.selector === "#items")));
  const unsafe = await capture('<form><button id="submit" aria-expanded="false">Submit</button></form>', '', { states: [{ name: "unsafe", selector: "#submit" }] });
  assert.ok(unsafe.pages[0].limitations.some(l => l.includes("non-form disclosure")));
});

test("asset failures and screenshot budgets explicitly prevent complete coverage", { timeout: 60000 }, async () => {
  const failed = await capture('<img src="/missing.png" width="50" height="50">');
  assert.ok(reviews(failed).every(v => v.status === "partial"));
  assert.ok(findings(failed).some(f => f.rule === "broken-image"));
  const browser = await launchWebsiteBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(html('<p>hello</p><div style="height:2000px"></div>'));
    const limited = await captureVisualReview(page, { frames: 1, bytes: 900000 });
    assert.equal(limited.status, "partial"); assert.equal(limited.frames.length, 1);
    assert.match(limited.limitations.join(), /budget/);
    await page.setContent('<html><body></body></html>');
    const blank = await captureVisualReview(page, { frames: 5, bytes: 900000 });
    assert.equal(blank.status, "partial");
  } finally { await browser.close(); }
});

test("a separate Katie turn restores owned tiles for comparison without presenting old images as fresh", { timeout: 60000 }, async () => {
  const website = await capture('<p id="issue">Original offer</p>', '#issue{width:30px;height:10px;overflow:hidden}');
  const actor = "11111111-1111-4111-8111-111111111111", chat = "22222222-2222-4222-8222-222222222222", request = "33333333-3333-4333-8333-333333333333";
  const files = new Map<string, string>();
  const store = createWebsiteEvidenceStore({ getBucket: async () => ({ data: { public: false } }), from: () => ({ upload: async (p: string, s: string) => { files.set(p, s); return {}; }, list: async () => ({ data: [...files.keys()].map(p => ({ name: p.split('/').at(-1) })) }), download: async (p: string) => ({ data: new Blob([files.get(p)!]) }) }) } as any);
  await store.save(actor, chat, request, browserResearchEvidence(website, params.user));
  const websiteHistory=[{role:'user',content:params.user},{role:'assistant',content:'The rendered website inspection is saved.'}];
  const unrelated=await store.restore(actor,chat,'Explain that photo in more detail',websiteHistory,{hasCurrentAttachments:true});
  assert.equal(unrelated.context,'');assert.deepEqual(unrelated.images,[]);assert.equal(unrelated.previousWebsiteEvidence,undefined);
  const restored = await store.restore(actor, chat, "Review the site again", websiteHistory);
  assert.equal(restored.fresh,true);
  assert.deepEqual(restored.images, []); assert.deepEqual(restored.previousWebsiteEvidence, website);
  const after = await capture('<p id="issue">Original offer</p>', '', {}, restored.previousWebsiteEvidence);
  assert.ok(after.comparisons?.every(c => c.issues.every(i => i.status === "resolved")));
  assert.equal((await store.restore(request, chat, "Review the site again", websiteHistory)).previousWebsiteEvidence, undefined);
});


test("Katie's lead and critique receive actual tile images and measured findings without model erasure", { timeout: 60000 }, async () => {
  const website = await capture('<p id="issue">Original full service offer</p>', '#issue{width:30px;height:10px;overflow:hidden}');
  const calls = new Map<string, ChatGenerateParams[]>();
  const provider = (name: LlmProvider["name"], text: string): LlmProvider => ({ name, async listModels() { return [name]; }, async generate(p) { calls.set(name, [...(calls.get(name) ?? []), p]); return { provider: name, model: name, text }; } });
  const lead = provider("anthropic", '{"action":"ready","synthesisBrief":"Use the evidence."}');
  const research = provider("grok", "No visual problems found by this model.");
  const critique = provider("openai", '{"action":"answer","answer":"Keep the measured findings."}');
  await runAdaptiveCollaboration({
    requestId: "integrated-tiles", params, leadProvider: lead, leadModelId: "lead", providers: [lead, research, critique],
    collectWebsiteEvidence: async () => website,
    async selectHelper(context) { return context.request.capability === "research" ? { provider: research, modelId: "web" } : { provider: critique, modelId: "critic" }; },
  });
  for (const name of ["anthropic", "openai"]) {
    const received = calls.get(name)?.at(-1);
    assert.ok(received, name + " did not receive a review");
    assert.equal(received.images?.length, websiteImages(website).length, name + " lost tile images");
    assert.ok(received.images?.every((image, i) => image === websiteImages(website)[i]));
    assert.match(received?.user ?? "", /clipped-text/);
    assert.match(received?.user ?? "", /No visual problems found by this model/);
  }
});
