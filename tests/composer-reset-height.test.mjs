import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { chromium } from "playwright-core";
import bundledChromium from "@sparticuz/chromium";

const composer = readFileSync("components/chat-composer-input.tsx", "utf8");
const resetEffect = /  \/\/ Resetting the draft does not fire onChange\. Recalculate the DOM height\n  \/\/ after external clears, restores and conversation switches as well\.\n  useEffect\(\(\) => \{\n    scheduleResize\(\);\n  \}, \[props\.externalValue, props\.resetVersion\]\);\n\n/;
const artifacts = "test-artifacts/composer-height";
const longText = Array.from({ length: 20 }, (_, n) => `Synthetic draft line ${n + 1}`).join("\n");
let browser;
let css;

before(async () => {
  mkdirSync(artifacts, { recursive: true });
  // Render the actual component with its Tailwind classes, not hand-written
  // textarea dimensions or a mocked scrollHeight/requestAnimationFrame.
  css = (await postcss([tailwindcss({
    content: [{ raw: composer, extension: "tsx" }],
    corePlugins: { preflight: true },
  })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined })).css;
  browser = await chromium.launch({
    executablePath: process.env.KATIE_TEST_CHROMIUM || await bundledChromium.executablePath(),
    args: bundledChromium.args,
    headless: true,
  });
});
after(async () => { await browser?.close(); });

test("composer recalculates textarea height on external clears and conversation resets", () => {
  assert.match(composer, /useEffect\(\(\) => \{\s*scheduleResize\(\);\s*\}, \[props\.externalValue, props\.resetVersion\]\)/);
  assert.match(composer, /textarea\.style\.height = "auto"/);
  assert.match(composer, /Math\.min\(textarea\.scrollHeight, 192\)/);
});

test("local typing still resizes independently of debounced draft persistence", () => {
  assert.match(composer, /setValue\(next\);\s*scheduleResize\(\);/);
  assert.match(composer, /setTimeout\(\(\) => \{\s*lastCommitted\.current = next/);
});

async function mount(viewport, source = composer) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: 844 },
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
  });
  const page = await context.newPage();
  const errors = [];
  const outbound = [];
  page.on("pageerror", error => errors.push(error.message));
  // No application backend, credentials, provider calls, or live messages.
  await page.route("**/*", route => { outbound.push(route.request().url()); return route.abort(); });
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const react = ["react", "react-dom"].map(name =>
    readFileSync(`node_modules/${name}/umd/${name}.production.min.js`, "utf8")).join("\n");
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root" style="max-width:900px;margin:12px"></div><script>${react}</script><script>
    const exports = {};
    const require = name => {
      if (name === "react") return React;
      if (name === "react/jsx-runtime") return {
        jsx: (type, props, key) => React.createElement(type, {...props, key}),
        jsxs: (type, props, key) => React.createElement(type, {...props, key}),
        Fragment: React.Fragment
      };
      throw Error("Unexpected component dependency: " + name);
    };
    ${code}
    const root = ReactDOM.createRoot(document.getElementById("root"));
    const f = window.fixture = {
      chatId: "chat-a", externalValue: "", resetVersion: 0,
      currentValueRef: {current: ""}, textareaRef: {current: null},
      commits: [], submissions: [], renders: 0, autoEcho: true,
      reset(value) { this.externalValue = value; this.resetVersion++; this.render(); },
      echo(value) { this.externalValue = value; this.render(); },
      switchChat(id, value) {
        this.chatId = id; this.externalValue = value; this.resetVersion++;
        this.currentValueRef.current = value; this.render();
      },
      unmount() { root.unmount(); },
      render() {
        this.renders++;
        const chatId = this.chatId;
        const props = {
          externalValue: this.externalValue, resetVersion: this.resetVersion,
          currentValueRef: this.currentValueRef, textareaRef: this.textareaRef,
          onDraftChange: value => {
            this.commits.push({chatId, value});
            if (this.autoEcho && chatId === this.chatId) this.echo(value);
          },
          onKeyDown: () => {}, onPaste: () => {}, onCancel: () => {},
          actorName: "Katie", fileControl: null, emojiControl: null,
          managed: false, draftReady: true, attachmentsReady: true,
          hasAttachments: false, composerAttachmentsReady: true,
          hasValidChatSelection: true, loading: false, uploadingFiles: false,
          collaborationActive: false, routingInFlight: false, statusMessage: ""
        };
        // Match ChatPanel's key={chatId}, current-value submission, and
        // externally driven reset; do not substitute a fake textarea.
        root.render(React.createElement("form", {onSubmit: event => {
          event.preventDefault();
          this.submissions.push(this.currentValueRef.current);
          this.reset("");
        }}, React.createElement(exports.ChatComposerInput, {...props, key: chatId})));
      }
    };
    f.render();
  </script></body></html>`);
  await page.locator("textarea").waitFor();
  await frames(page);
  return { page, context, errors, outbound };
}

async function frames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}
async function dimensions(page) {
  return page.locator("textarea").evaluate(el => ({
    value: el.value, height: el.getBoundingClientRect().height,
    scrollHeight: el.scrollHeight, inlineHeight: el.style.height,
    maxHeight: Number.parseFloat(getComputedStyle(el).maxHeight),
    pageOverflow: document.documentElement.scrollWidth > innerWidth,
  }));
}
async function assertEmpty(page, emptyHeight, label) {
  await frames(page);
  const d = await dimensions(page);
  assert.equal(d.value, "", label + ": value cleared");
  assert.ok(Math.abs(d.height - emptyHeight) <= 1, `${label}: empty height ${d.height} != ${emptyHeight}`);
  assert.equal(d.pageOverflow, false, label + ": no horizontal overflow");
  assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
}

for (const viewport of [
  { name: "desktop", width: 1280, mobile: false, cap: 192 },
  { name: "mobile", width: 390, mobile: true, cap: 144 },
]) {
  test(`real Chromium ${viewport.name}: resets, draft restoration, chat switching and typing remain correct`, { timeout: 60000 }, async () => {
    const { page, context, errors, outbound } = await mount(viewport);
    const checks = [];
    try {
      const emptyHeight = (await dimensions(page)).height;
      assert.ok(emptyHeight >= 44 && emptyHeight <= 60);
      assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);

      await page.locator("textarea").fill(longText);
      await frames(page);
      const expanded = await dimensions(page);
      assert.equal(expanded.height, viewport.cap);
      assert.equal(expanded.maxHeight, viewport.cap);
      assert.equal(expanded.pageOverflow, false);
      await page.screenshot({ path: `${artifacts}/${viewport.name}-expanded.png` });
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await assertEmpty(page, emptyHeight, "send");
      assert.equal(await page.evaluate(() => fixture.submissions.at(-1)), longText);
      await page.screenshot({ path: `${artifacts}/${viewport.name}-after-send.png` });
      checks.push("long draft -> send -> empty height; full current text submitted");

      await page.evaluate(text => fixture.reset(text), longText);
      await frames(page);
      assert.equal((await dimensions(page)).value, longText);
      assert.equal((await dimensions(page)).height, viewport.cap);
      await page.evaluate(() => fixture.reset(""));
      await assertEmpty(page, emptyHeight, "external clear");
      checks.push("external draft restoration and clear without an input event");

      // Reset version changes while the external value remains empty.
      await page.evaluate(() => { fixture.autoEcho = false; });
      await page.locator("textarea").fill(longText);
      await frames(page);
      await page.evaluate(() => fixture.reset(""));
      await assertEmpty(page, emptyHeight, "reset-version-only");
      checks.push("reset-version-only change discards local unsaved text and resizes");

      await page.locator("textarea").fill("Saved earlier");
      await page.waitForFunction(() => fixture.commits.at(-1)?.value === "Saved earlier");
      const newer = "Typed after the saved version\n".repeat(12).trim();
      await page.locator("textarea").fill(newer);
      await page.evaluate(() => fixture.echo("Saved earlier"));
      await frames(page);
      assert.equal((await dimensions(page)).value, newer, "stale echo must not erase newer typing");
      assert.equal((await dimensions(page)).height, viewport.cap);
      await page.waitForFunction(value => fixture.commits.at(-1)?.value === value, newer);
      checks.push("stale debounced parent echo preserves newer local typing and eventual save");

      await page.evaluate(() => { fixture.autoEcho = true; fixture.reset(""); });
      await assertEmpty(page, emptyHeight, "typing setup");
      const prior = await page.evaluate(() => ({ commits: fixture.commits.length, renders: fixture.renders }));
      await page.locator("textarea").pressSequentially("Fast typing", { delay: 5 });
      assert.equal(await page.evaluate(() => fixture.renders), prior.renders, "no per-keystroke parent render");
      assert.equal(await page.evaluate(() => fixture.commits.length), prior.commits, "draft commit stays debounced");
      await page.waitForFunction(() => fixture.commits.at(-1)?.value === "Fast typing");
      assert.equal(await page.evaluate(() => fixture.commits.length), prior.commits + 1);
      checks.push("local typing remains isolated; one debounced draft commit");

      const beforeSwitch = await page.evaluate(() => fixture.commits.length);
      await page.locator("textarea").fill(longText);
      await page.evaluate(text => fixture.switchChat("chat-b", text), longText);
      await frames(page);
      assert.equal((await dimensions(page)).value, longText);
      assert.equal((await dimensions(page)).height, viewport.cap, "restored draft resizes on keyed mount");
      await page.evaluate(() => fixture.switchChat("chat-c", ""));
      await assertEmpty(page, emptyHeight, "chat switch");
      await page.waitForTimeout(350);
      assert.equal(await page.evaluate(() => fixture.commits.length), beforeSwitch, "old chat timer must not save into the new chat");
      checks.push("keyed conversation switches restore drafts and cancel old-chat commits");

      const beforeUnmount = await page.evaluate(() => fixture.commits.length);
      await page.locator("textarea").fill("Unsaved before unmount");
      await page.evaluate(() => fixture.unmount());
      await page.waitForTimeout(350);
      assert.equal(await page.evaluate(() => fixture.commits.length), beforeUnmount);
      checks.push("unmount cancels pending draft save and resize without browser errors");
      assert.deepEqual(errors, []);
      assert.deepEqual(outbound, []);
      console.log(JSON.stringify({ qualification: "COMPOSER_BROWSER_PASS", viewport: viewport.name,
        componentSha256: createHash("sha256").update(composer).digest("hex"),
        emptyHeight, expandedHeight: expanded.height, checks, externalRequests: outbound.length }));
    } finally { await context.close(); }
  });

  test(`real Chromium ${viewport.name}: removing the fix reproduces the tall empty composer`, { timeout: 30000 }, async () => {
    assert.match(composer, resetEffect, "negative control must remove only the exact reset effect");
    const withoutFix = composer.replace(resetEffect, "");
    const { page, context, errors, outbound } = await mount(viewport, withoutFix);
    try {
      const emptyHeight = (await dimensions(page)).height;
      await page.locator("textarea").fill(longText);
      await frames(page);
      const expandedHeight = (await dimensions(page)).height;
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await frames(page);
      const d = await dimensions(page);
      assert.equal(d.value, "");
      assert.equal(d.height, expandedHeight, "without the fix, clearing must leave the old height");
      assert.ok(d.height > emptyHeight + 20, "negative control must actually reproduce the user-visible defect");
      assert.deepEqual(errors, []);
      assert.deepEqual(outbound, []);
      console.log(JSON.stringify({ qualification: "COMPOSER_NEGATIVE_CONTROL_REPRODUCED",
        viewport: viewport.name, emptyHeight, staleEmptyHeight: d.height }));
    } finally { await context.close(); }
  });
}
