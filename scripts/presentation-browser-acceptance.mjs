/**
 * Isolated browser acceptance of the actual production renderer.
 * Creates a disposable route only in the local checkout, never commits it or
 * sends test data to the production app. Does not certify provider delivery.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium as playwrightChromium } from "playwright-core";
import chromium from "@sparticuz/chromium";

const root = resolve(".");
const fixtureDir = resolve(root, "app/presentation-acceptance-fixture");
const fixturePath = resolve(fixtureDir, "page.tsx");
const port = Number(process.env.KATIE_PRESENTATION_TEST_PORT ?? 38091);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid browser fixture port");
if (existsSync(fixturePath)) throw new Error("Refusing to replace an existing route");

const equationMarkdown = "At a $25 million education and professional development company, I led the $100 million sale. Budget $1,000 to $2,000. Currency $40k to $120k. Inline $x^2$ and $2m$. Code `\"$100k\"`.\n\n$$\nx^2+y^2=z^2\n$$";
const fixture = `
"use client";
import { StructuredResponseView } from "@/components/structured-response-view";
import { AssistantMarkdown } from "@/components/assistant-markdown";
import { ChatPanel } from "@/components/chat-panel";
import { Profiler } from "react";
function onChatRender() { const browser = window as typeof window & { __katieChatCommits?: number }; browser.__katieChatCommits = (browser.__katieChatCommits ?? 0) + 1; }
import type { StructuredResponse } from "@/lib/chat/structured-response";
const response = {
  version: 1, fallbackMarkdown: "Before. After.",
  blocks: [
    { type: "markdown", text: "## Before.\\n\\n1. First item\\n2. Second item\\n\\n" },
    { type: "metric", label: "Verified revenue", value: "$120" },
    { type: "chart", chart: "donut", title: "Illustrative mix", points: [{ label: "A", value: 25 }, { label: "B", value: 75 }], evidence: { origin: "illustrative", description: "Test-only figures" }, accessibleSummary: "Illustrative 25 and 75 mix" },
    { type: "selector", title: "Forecast scenario", options: [{ label: "Base", description: "Base case result" }, { label: "Upside", description: "Upside case result" }] },
    { type: "media", assetIndex: 0, alt: "Authorized fixture image", caption: "Saved image" },
    { type: "markdown", text: "After." },
  ],
} as StructuredResponse;
export default function PresentationAcceptancePage() {
  return <main className="mx-auto max-w-2xl p-6" data-testid="presentation-fixture">
    <StructuredResponseView response={response} ordered assets={[{ type: "image", url: "https://images.example.test/saved.png" }]} />
    <div data-testid="equation"><AssistantMarkdown>{${JSON.stringify(equationMarkdown)}}</AssistantMarkdown></div>
    <div className="h-[700px]" data-testid="stream-chat">
      <aside id="katie-live-status" data-testid="thinking-status-rail" />
      <Profiler id="chat" onRender={onChatRender}><ChatPanel actorId="11111111-1111-4111-8111-111111111111" chatId="22222222-2222-4222-8222-222222222222" activeActorName="Acceptance" activeChatTitle="Streaming regression" activeRepoId="" repoInjectionEnabled={false} statusRailOpen /></Profiler>
    </div>
  </main>;
}
`;

let server;
let browser;
let serverOutput = "";
const url = `http://127.0.0.1:${port}/presentation-acceptance-fixture`;
async function ready() {
  for (let attempt = 0; attempt < 75; attempt++) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error("Next exited: " + serverOutput.slice(-4000));
    try {
      const result = await fetch(url);
      if (result.ok) return;
    } catch {}
    await new Promise(ok => setTimeout(ok, 1200));
  }
  throw new Error("Next did not become ready: " + serverOutput.slice(-4000));
}
async function cleanup() {
  try { await browser?.close(); } catch {}
  if (server) { try { server.kill("SIGTERM"); } catch {} }
  await rm(fixtureDir, { recursive: true, force: true });
  await rm(resolve(root, ".next/types/app/presentation-acceptance-fixture"), { recursive: true, force: true });
}
try {
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(fixturePath, fixture, "utf8");
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture", SUPABASE_SERVICE_ROLE_KEY: "fixture", NEXT_TELEMETRY_DISABLED: "1" },
  });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", chunk => { serverOutput = (serverOutput + String(chunk)).slice(-12000); });
  await ready();
  browser = await playwrightChromium.launch({
    executablePath: await chromium.executablePath(),
    args: chromium.args,
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  let historySize = 0;
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON();
    const payload = url.pathname === "/api/models" ? { openai: ["fixture"] }
      : url.pathname === "/api/messages" ? { messages: Array.from({ length: historySize }, (_, i) => ({
        id: `fixture-message-${i}`, role: i % 2 === 0 ? "user" : "assistant",
        content: i % 2 === 0 ? "Historical question "+i : "## Historical answer "+i+"\\n\\n".concat("Financial modeling and operations context. ".repeat(12)),
        chatId: "22222222-2222-4222-8222-222222222222", createdAt: "2026-11-03T12:00:00.000Z"
      })) }
      : url.pathname === "/api/ui-state" ? { state: { key: body?.key ?? url.searchParams.get("key"), version: 1, value: body?.value ?? {} } }
      : url.pathname === "/api/version" ? { version: "fixture" } : {};
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  // A gated fetch stream verifies the real ChatPanel before the final event,
  // without a provider call or a timing-dependent sleep.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (new URL(input instanceof Request ? input.url : String(input), location.href).pathname !== "/api/chat") return original(input, init);
      window.__lastChatPayload = JSON.parse(init.body);
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        const emit = value => controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
        emit({ type: "metadata", provider: "openai", modelId: "fixture" });
        emit({ type: "delta", text: "Streaming first part. " });
        window.__finishPresentationStream = () => {
          emit({ type: "content", provider: "openai", model: "fixture", text: "Streaming first part. Final answer.", presentation: {
            version: 1, fallbackMarkdown: "Streaming first part. Final answer.", blocks: [
              { type: "markdown", text: "Streaming first part. " },
              { type: "metric", label: "Stream complete", value: "Ready" },
              { type: "markdown", text: "Final answer." },
            ],
          } });
          controller.close();
        };
      } }), { headers: { "content-type": "application/x-ndjson" } });
    };
  });
  await page.route("https://images.example.test/saved.png", route => route.fulfill({
    status: 200, contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64"),
  }));
  await page.goto(url);
  await page.locator('[data-testid="presentation-fixture"]').waitFor();
  const getText = () => page.locator('[data-testid="presentation-fixture"]').innerText();
  let text = await getText();
  if (!(text.indexOf("Before.") < text.indexOf("Verified revenue") && text.indexOf("Verified revenue") < text.indexOf("After."))) {
    throw new Error("Ordered components not rendered in canonical order");
  }
  if (await page.locator('svg[aria-label="Illustrative 25 and 75 mix"] circle').count() < 2) throw new Error("Donut SVG not rendered");
  if (await page.locator('img[alt="Authorized fixture image"]').count() !== 1) throw new Error("Saved media missing");
  if (await page.locator('[data-testid="equation"] .katex').count() !== 3) throw new Error("Inline/display KaTeX failed");
  if (await page.locator('[data-testid="equation"] .katex-display').count() < 1) throw new Error("Display equation not rendered");
  if ((await page.locator('[data-testid="equation"] code').innerText()) !== '"$100k"') throw new Error("Currency handling altered code");
  if (await page.getByRole("heading", {name:"Before."}).count() !== 1) throw new Error("Ordered heading missing");
  const listStyle = await page.locator('[aria-label="Structured assistant response"] ol').evaluate(el => getComputedStyle(el).listStyleType);
  if (listStyle !== "decimal") throw new Error("Ordered list lost numbering: " + listStyle);
  if (!(await page.locator('[data-testid="equation"]').innerText()).includes("$40k to $120k")) throw new Error("Currency interpreted as math");
  const currencyText = await page.locator('[data-testid="equation"]').innerText();
  if (!currencyText.includes("At a $25 million education and professional development company, I led the $100 million sale.")) throw new Error("Full-dollar prose rendered as math");
  if (!currencyText.includes("Budget $1,000 to $2,000.")) throw new Error("Comma-formatted currency rendered as math");
  if (await page.locator('[data-testid="equation"] .katex').count() !== 3) throw new Error("Currency prose created spurious KaTeX nodes");
  await page.getByRole("button", { name: "Upside" }).click();
  if (!(await getText()).includes("Upside case result")) throw new Error("Interactive selector failed");
  await page.reload();
  await page.getByRole("button", { name: "Base" }).waitFor();
  if (!(await getText()).includes("Base case result")) throw new Error("Refresh did not restore the presentation");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  if (mobile.width > mobile.viewport + 20) throw new Error("Mobile presentation overflows: " + JSON.stringify(mobile));
  // Qualify the central conversation progress UI at desktop width, where the
  // separate right-side status rail is also present in the real workspace.
  await page.setViewportSize({ width: 1280, height: 860 });
  const composer = page.getByPlaceholder("Ask Acceptance…");
  await composer.fill("Exercise the gated stream.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const centralProgress = page.getByLabel("Katie response progress", { exact: true });
  await centralProgress.waitFor();
  const preview = centralProgress.getByLabel("Streaming assistant response", { exact: true });
  await preview.waitFor();
  if (!(await preview.innerText()).includes("Streaming first part.")) {
    throw new Error("Streamed answer is missing from the central conversation progress bubble");
  }
  if (!(await centralProgress.innerText()).includes("Katie is responding")) {
    throw new Error("Central progress stage was not updated when answer streaming began");
  }
  const rightRail = page.getByTestId("thinking-status-rail");
  if ((await rightRail.innerText()).includes("Streaming first part.")) {
    throw new Error("The small right-side Thinking rail duplicated the answer");
  }
  if (await page.getByText("Stream complete", { exact: true }).count()) throw new Error("Uncommitted visual rendered during stream");
  if (!(await page.getByRole("button", { name: "Cancel", exact: true }).isVisible())) throw new Error("Stream completed before preview assertion");
  await page.evaluate(() => window.__finishPresentationStream());
  await centralProgress.waitFor({ state: "hidden" });
  await page.getByText("Stream complete", { exact: true }).waitFor();
  if ((await page.locator('[data-testid="stream-chat"]').innerText()).includes("<katie-presentation-v1>")) throw new Error("Internal presentation markup leaked");

  // Measure the real composer in Chromium, with React commits tracked by a
  // Profiler around ChatPanel. The same text must survive draft persistence.
  const probeInput = async label => {
    const result = await page.evaluate(async () => {
      const textarea = document.querySelector('textarea[placeholder="Ask Acceptance…"]');
      if (!textarea) throw new Error("Composer missing");
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      const runtime = window;
      const beforeCommits = runtime.__katieChatCommits ?? 0;
      const observerResults = [];
      const observer = new PerformanceObserver(list => observerResults.push(...list.getEntries().map(entry=>entry.duration)));
      try { observer.observe({ type: "longtask", buffered: false }); } catch {}
      const durations = [];
      let expected = textarea.value;
      const characters = "Keystrokes must remain responsive even after long conversations.";
      for (const char of characters) {
        const before = performance.now();
        expected += char;
        nativeSetter.call(textarea, expected);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (textarea.value !== expected) throw new Error("Composer lost a keystroke before paint");
        durations.push(performance.now() - before);
      }
      observer.disconnect();
      const sorted = [...durations].sort((a,b)=>a-b);
      return {
        p95: sorted[Math.ceil(sorted.length*0.95)-1],
        commits: (runtime.__katieChatCommits ?? 0) - beforeCommits,
        strokes: characters.length,
        longTasks: observerResults.length,
        maxLongTask: Math.max(0,...observerResults),
        text: expected,
      };
    });
    if (result.p95 >= 50) throw new Error(label + " p95 typing latency exceeds 50ms: " + JSON.stringify(result));
    if (result.commits > result.strokes * 2 + 4) throw new Error(label + " React commits per keystroke regressed: " + JSON.stringify(result));
    if (!Number.isFinite(result.maxLongTask)) throw new Error(label + " invalid long task measurement");
    return result;
  };
  await composer.fill("");
  const shortTyping = await probeInput("short history");
  await page.waitForTimeout(1000);
  const recoveredDraft = await page.evaluate(() => sessionStorage.getItem("katie.draft.v1.22222222-2222-4222-8222-222222222222"));
  if (recoveredDraft !== shortTyping.text) throw new Error("Debounced composer draft not persisted");
  await page.reload();
  if (await composer.inputValue() !== shortTyping.text) throw new Error("Composer draft did not recover after reload");
  historySize = 160;
  await page.reload();
  await page.getByText("Historical answer 159", { exact: false }).waitFor();
  await composer.fill("");
  const longTyping = await probeInput("160-message history");
  await composer.fill("Quick Enter should send without waiting for draft debounce.");
  await composer.press("Enter");
  await page.getByLabel("Katie response progress", { exact: true }).waitFor();
  const sent = await page.evaluate(() => window.__lastChatPayload?.message);
  if (sent !== "Quick Enter should send without waiting for draft debounce.") throw new Error("Enter submitted stale composer text: " + sent);
  await page.evaluate(() => window.__finishPresentationStream());
  await page.getByLabel("Katie response progress", { exact: true }).waitFor({state:"hidden"});
  console.log(JSON.stringify({ passed: true, ordered: true, donut: true, image: true, math: true, interaction: true, reload: true, mobile: true, streamingPreview: true, centralProgressStream: true, noRightRailDuplication: true, composerPerformance: { shortTyping, longTyping, persistedDraft: true, quickEnter: true } }));

} finally {
  await cleanup();
}
