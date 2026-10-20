import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import bundledChromium from "@sparticuz/chromium";
const origin = process.env.KATIE_UI_TEST_ORIGIN ?? "http://127.0.0.1:3141";
const a = "11111111-1111-4111-8111-111111111111",
  b = "22222222-2222-4222-8222-222222222222",
  c = "33333333-3333-4333-8333-333333333333",
  m = "44444444-4444-4444-8444-444444444444",
  p = "55555555-5555-4555-8555-555555555555";
const actors = [
  { id: a, name: "Katie", purpose: "Coordinate outcomes." },
  {
    id: b,
    name: "Internal worker",
    purpose: "Internal only",
    managedAgentId: "managed",
  },
  {
    id: "66666666-6666-4666-8666-666666666666",
    name: "Application advisor",
    purpose: "Help prepare executive applications.",
    routingProfile: {
      summary: "Prepare executive applications using verified experience.",
    },
  },
];
const chats = [
  { id: "99999999-9999-4999-8999-999999999999", actorId: a, title: "Disposable UI check", createdAt: "2026-10-20T12:00:00Z", updatedAt: "2026-10-20T13:00:00Z" },
  {
    id: c,
    actorId: a,
    title: "Operations analysis",
    createdAt: "2026-10-20T12:00:00Z",
    updatedAt: "2026-10-20T14:00:00Z",
  },
  {
    id: "77777777-7777-4777-8777-777777777777",
    actorId: b,
    title: "Internal QA history",
    createdAt: "2026-10-20T12:00:00Z",
    updatedAt: "2026-10-20T14:00:00Z",
  },
];
const item = {
  key: "mission:" + m,
  source: "mission",
  id: m,
  title: "Service desk analysis",
  status: "completed",
  phase: "review",
  detail: "Independent review passed.",
  updatedAt: "2026-10-20T14:00:00Z",
  chatId: c,
  specialist: "Operations",
  parentKey: null,
  isTest: false,
  result: "75% utilization. Seven requests per day spare capacity.",
  reviewState: "pass",
  deliveryState: "delivered",
};
const project = {
  ...item,
  key: "project:" + p,
  source: "project",
  id: p,
  title: "Website scope",
  status: "awaiting_approval",
  phase: "approval",
  result: null,
  reviewState: "not established",
  deliveryState: "unknown",
};
const states = new Map(),
  mutations = [],
  errors = [];
let workFailure = false;
let server;
if (process.env.KATIE_UI_START_SERVER === "1") {
  server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      process.env.KATIE_UI_SERVER_MODE ?? "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(new URL(origin).port),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let logs = "";
  server.stdout.on("data", (b) => {
    logs += b;
  });
  server.stderr.on("data", (b) => {
    logs += b;
  });
  console.log("Starting workspace server");
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(origin, { signal: AbortSignal.timeout(3000) });
      if (res.ok) break;
    } catch {}
    if (server.exitCode !== null) throw Error(logs);
    await new Promise((r) => setTimeout(r, 500));
    if (i === 119) throw Error("UI server did not start: " + logs);
  }
}
console.log("Server ready; starting Chromium");
const browser = await chromium.launch({
  executablePath:
    process.env.KATIE_TEST_CHROMIUM ?? (await bundledChromium.executablePath()),
  args: bundledChromium.args,
  headless: true,
});
const output = process.env.KATIE_UI_SCREENSHOTS ?? "/tmp/katie-ui-acceptance";
mkdirSync(output, { recursive: true });
let inspectedPage;
try {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage();
  inspectedPage = page;
  page.setDefaultTimeout(60000);
  page.on("pageerror", (e) => errors.push(e.message));
  await context.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      body = req.postDataJSON();
    const reply = (data, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    if (req.method() !== "GET") mutations.push({ path: url.pathname, body });
    if (url.pathname === "/api/actors") return reply({ actors });
    if (url.pathname === "/api/chats") {
      if (req.method() === "DELETE") {
        const index = chats.findIndex(chat => chat.id === url.searchParams.get("id"));
        assert.ok(index >= 0);
        chats.splice(index, 1);
        return reply({ success: true });
      }
      if (req.method() === "POST") {
        const chat = {
          ...body,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        chats.push(chat);
        return reply({ chat }, 201);
      }
      return reply({ chats });
    }
    if (url.pathname === "/api/admin/repos") return reply({ repos: [] });
    if (url.pathname === "/api/ui-state") {
      if (req.method() === "PATCH") {
        const old = states.get(body.key) ?? {
          key: body.key,
          version: 0,
          value: {},
        };
        if (body.version !== old.version)
          return reply({ error: "State conflict" }, 409);
        const state = {
          ...old,
          version: old.version + 1,
          value: { ...old.value, ...body.value },
        };
        states.set(body.key, state);
        return reply({ state });
      }
      const key = url.searchParams.get("key");
      return reply(
        key
          ? { state: states.get(key) ?? { key, version: 0, value: {} } }
          : { states: [...states.values()] },
      );
    }
    if (url.pathname === "/api/work")
      return reply(
        workFailure
          ? { error: "Unavailable" }
          : {
              items: [item, project],
              warnings: [],
              checkedAt: new Date().toISOString(),
              limit: 500,
            },
        workFailure ? 503 : 200,
      );
    if (url.pathname === "/api/specialists")
      return reply({
        specialists: [
          {
            id: "88888888-8888-4888-8888-888888888888",
            actor_id: a,
            slug: "operations",
            title: "Operations",
            description: "Assess process capacity and bottlenecks.",
            capabilities: ["operations_analysis"],
            status: "active",
            autonomy: "delegated",
            adapter: "mission",
            version: 1,
          },
        ],
      });
    if (url.pathname === "/api/missions/pending")
      return reply({ approvals: [] });
    if (url.pathname === "/api/projects/pending")
      return reply({ approvals: [] });
    if (url.pathname === "/api/projects")
      return reply({ project: null, approval: null });
    if (url.pathname === "/api/missions")
      return reply({
        mission: item,
        jobs: [
          {
            id: "review",
            role: "review",
            status: "completed",
            result: { verdict: "pass" },
          },
        ],
      });
    if (url.pathname === "/api/models")
      return reply({ openai: ["gpt-example"], google: [] });
    if (url.pathname === "/api/version") return reply({ version: "fixture" });
    if (url.pathname === "/api/messages") return reply({ messages: [] });
    if (url.pathname === "/api/search")
      return reply({
        results: [
          {
            id: c,
            kind: "Conversation",
            title: "Operations analysis",
            snippet: "Source discussion",
            href: "/conversations/" + c,
          },
        ],
        warnings: [],
      });
    return reply({});
  });
  console.log("Checking Home");
  await page.goto(origin);
  await page
    .getByRole("heading", { name: "Welcome back", exact: true })
    .waitFor();
  await page.getByText("Operations analysis", { exact: true }).waitFor();
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "Delete chat: Operations analysis", exact: true }).click();
  assert.equal(mutations.filter(r => r.path === "/api/chats").length, 0);
  await page.screenshot({ path: output + "/home-desktop.png", fullPage: true });
  await page.getByRole("link", { name: "Conversations", exact: true }).click();
  await page
    .getByRole("heading", { name: "Conversations", exact: true })
    .waitFor();
  assert.equal(await page.getByText("Internal QA history").count(), 0);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete chat: Disposable UI check", exact: true }).click();
  await page.getByText("Disposable UI check", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(chats.some(chat => chat.title === "Disposable UI check"), false);
  await page.getByLabel("Search conversations").fill("Operations");
  await page.getByText("Operations analysis", { exact: true }).click();
  await page.getByPlaceholder("Ask Katie…").waitFor();
  const composer = page.getByPlaceholder("Ask Katie…");
  const modelSettings = page.getByRole("button", { name: "Hide answering models", exact: true });
  assert.equal(await modelSettings.getAttribute("aria-expanded"), "true");
  await page.getByLabel("Answering model for openai", { exact: true }).selectOption("gpt-example");
  assert.equal(await page.getByLabel("Answering model for openai", { exact: true }).inputValue(), "gpt-example");
  await modelSettings.click();
  await page.getByRole("button", { name: "Answering model: gpt-example", exact: true }).click();
  await page.getByLabel("Answering model for openai", { exact: true }).selectOption("");
  await composer.fill("Keep this draft without executing.");
  await page.getByText("Draft saved", { exact: true }).waitFor();
  assert.equal(
    states.get("chat:" + c).value.draft,
    "Keep this draft without executing.",
  );
  await page.locator('input[type="file"]').setInputFiles({name:"handoff-notes.txt",mimeType:"text/plain",buffer:Buffer.from("Pending attachment fixture")});
  await page.getByText(/handoff-notes.txt/).waitFor();
  await page.getByRole("link", { name: "Work", exact: true }).click();
  await page.getByRole("heading", { name: "Work", exact: true }).waitFor();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page
    .getByRole("heading", { name: "Service desk analysis", exact: true })
    .click();
  await page.getByRole("button", { name: "results", exact: true }).click();
  await page.getByText(item.result, { exact: true }).waitFor();
  await page.getByRole("link", { name: "Open original conversation" }).click();
  await composer.waitFor();
  assert.equal(
    await composer.inputValue(),
    "Keep this draft without executing.",
  );
  await page.reload();
  await composer.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector("textarea")?.value ===
      "Keep this draft without executing.",
  );
  await page.getByText(/handoff-notes.txt/).waitFor();
  await page.getByRole("link", { name: "Specialists", exact: true }).click();
  await page
    .getByRole("heading", { name: "Operations", exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("Internal worker", { exact: true }).count(),
    0,
  );
  await page.screenshot({
    path: output + "/specialists-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Work", exact: true }).click();
  await page.getByRole("button", { name: "Needs you", exact: true }).click();
  await page
    .getByRole("heading", { name: "Website scope", exact: true })
    .waitFor();
  await page.screenshot({ path: output + "/work-desktop.png", fullPage: true });
  workFailure = true;
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByText("Status unavailable. Retry the connection.").waitFor();
  assert.equal(
    await page.getByText("No project decisions or blockers found.").count(),
    0,
  );
  workFailure = false;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Navigation" }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(
    await page.getByRole("dialog", { name: "Navigation" }).count(),
    0,
  );
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Conversations", exact: true })
    .click();
  await page.getByText("Operations analysis", { exact: true }).click();
  await composer.waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: output + "/conversation-mobile.png",
    fullPage: true,
  });
  assert.equal(
    mutations.filter((r) => r.path === "/api/chat").length,
    0,
    "navigation and result inspection must never create execution",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "home",
        "chat deletion confirmation and list refresh",
        "visible answering model overrides",
        "worker filtering",
        "searchable conversations",
        "canonical links",
        "draft save and reload",
        "pending attachment persistence",
        "work results",
        "original conversation return",
        "specialist catalog",
        "pending work",
        "error state",
        "mobile drawer",
        "Escape focus",
        "no horizontal scrolling",
        "no duplicate execution",
      ],
      screenshots: output,
    }),
  );
} catch (error) {
  console.error("Failed URL", inspectedPage?.url());
  if (inspectedPage) {
    await inspectedPage
      .screenshot({ path: output + "/failure.png", fullPage: true })
      .catch(() => {});
    console.error(
      (await inspectedPage.locator("body").innerText()).slice(-5000),
    );
  }
  throw error;
} finally {
  await browser.close();
  if (server) server.kill("SIGTERM");
}
