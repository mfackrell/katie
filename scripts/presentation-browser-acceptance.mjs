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
    <div className="h-[700px]" data-testid="stream-chat"><ChatPanel actorId="11111111-1111-4111-8111-111111111111" chatId="22222222-2222-4222-8222-222222222222" activeActorName="Acceptance" activeChatTitle="Streaming regression" activeRepoId="" repoInjectionEnabled={false} /></div>
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
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON();
    const payload = url.pathname === "/api/models" ? { openai: ["fixture"] }
      : url.pathname === "/api/messages" ? { messages: [] }
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
  const composer = page.getByPlaceholder("Ask Acceptance…");
  await composer.fill("Exercise the gated stream.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const preview = page.getByLabel("Streaming assistant response", { exact: true });
  await preview.waitFor();
  if (!(await preview.innerText()).includes("Streaming first part.")) throw new Error("Answer deltas are not rendered before completion");
  if (await page.getByText("Stream complete", { exact: true }).count()) throw new Error("Uncommitted visual rendered during stream");
  if (!(await page.getByRole("button", { name: "Cancel", exact: true }).isVisible())) throw new Error("Stream completed before preview assertion");
  await page.evaluate(() => window.__finishPresentationStream());
  await preview.waitFor({ state: "hidden" });
  await page.getByText("Stream complete", { exact: true }).waitFor();
  if ((await page.locator('[data-testid="stream-chat"]').innerText()).includes("<katie-presentation-v1>")) throw new Error("Internal presentation markup leaked");
  console.log(JSON.stringify({ passed: true, ordered: true, donut: true, image: true, math: true, interaction: true, reload: true, mobile: true, streamingPreview: true }));
} finally {
  await cleanup();
}
