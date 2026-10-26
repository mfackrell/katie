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

const fixture = `
"use client";
import { StructuredResponseView } from "@/components/structured-response-view";
import { AssistantMarkdown } from "@/components/assistant-markdown";
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
    <div data-testid="equation"><AssistantMarkdown>{"Currency $40k to $120k. Inline $x^2$.\\n\\n$$\\nx^2+y^2=z^2\\n$$"}</AssistantMarkdown></div>
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
  if (await page.locator('[data-testid="equation"] .katex').count() !== 2) throw new Error("Inline/display KaTeX failed");
  if (await page.locator('[data-testid="equation"] .katex-display').count() < 1) throw new Error("Display equation not rendered");
  if (await page.getByRole("heading", {name:"Before."}).count() !== 1) throw new Error("Ordered heading missing");
  const listStyle = await page.locator('[aria-label="Structured assistant response"] ol').evaluate(el => getComputedStyle(el).listStyleType);
  if (listStyle !== "decimal") throw new Error("Ordered list lost numbering: " + listStyle);
  if (!(await page.locator('[data-testid="equation"]').innerText()).includes("$40k to $120k")) throw new Error("Currency interpreted as math");
  await page.getByRole("button", { name: "Upside" }).click();
  if (!(await getText()).includes("Upside case result")) throw new Error("Interactive selector failed");
  await page.reload();
  await page.getByRole("button", { name: "Base" }).waitFor();
  if (!(await getText()).includes("Base case result")) throw new Error("Refresh did not restore the presentation");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  if (mobile.width > mobile.viewport + 20) throw new Error("Mobile presentation overflows: " + JSON.stringify(mobile));
  console.log(JSON.stringify({ passed: true, ordered: true, donut: true, image: true, math: true, interaction: true, reload: true, mobile: true }));
} finally {
  await cleanup();
}
