// Opt-in live acceptance runner. Requires an authenticated Playwright storage-state
// file and dedicated disposable test chats; never bypasses Katie authentication.
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const configFile = process.env.KATIE_ACCEPTANCE_CONFIG;
const stateFile = process.env.KATIE_ACCEPTANCE_STORAGE_STATE;
const browserPath = process.env.KATIE_ACCEPTANCE_CHROMIUM;
if (!configFile || !stateFile || !browserPath) {
  throw new Error('Set KATIE_ACCEPTANCE_CONFIG, KATIE_ACCEPTANCE_STORAGE_STATE, and KATIE_ACCEPTANCE_CHROMIUM. No test was run.');
}
const cfg = JSON.parse(readFileSync(resolve(configFile), 'utf8'));
if (cfg.confirmLiveSpend !== true || !Array.isArray(cfg.cases) || cfg.cases.length < 1) {
  throw new Error('Explicit confirmLiveSpend:true and nonempty cases are required.');
}
if (!cfg.cases.every(c => c.name && c.url && c.message && c.provider && c.model)) {
  throw new Error('Each case requires name, url, message, provider and model.');
}
const baseOrigin = new URL(cfg.origin).origin;
if (new URL(cfg.origin).origin !== cfg.origin) throw new Error('origin must be exactly a URL origin');
for (const c of cfg.cases) {
  if (new URL(c.url).origin !== baseOrigin) throw new Error('Case URL must belong to configured origin');
}
const output = resolve(process.env.KATIE_ACCEPTANCE_OUTPUT || 'artifacts/adaptive-acceptance');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const context = await browser.newContext({ storageState: resolve(stateFile), viewport: { width: 1280, height: 900 } });
const results = [];
try {
  for (const [index, c] of cfg.cases.entries()) {
    const page = await context.newPage();
    const record = { name: c.name, provider: c.provider, model: c.model, url: c.url,
      startedAt: new Date().toISOString(), success: false, events: [], rendered: null };
    const pathPrefix = join(output, String(index + 1).padStart(2, '0') + '-' + c.name.replace(/[^a-z0-9-]/gi, '-'));
    let seenRequest = false;
    let capturedBody = null;
    try {
      page.on('request', req => {
        if (new URL(req.url()).pathname !== '/api/chat' || req.method() !== 'POST') return;
        const data = req.postDataJSON();
        if (data?.message !== c.message) return;
        seenRequest = true;
        record.sentOverride = { provider: data.overrideProvider ?? null, model: data.overrideModel ?? null };
        if (data.overrideProvider !== c.provider || data.overrideModel !== c.model) {
          record.routingMismatch = 'UI did not send the required explicit model override';
        }
      });
      page.on('response', async response => {
        if (new URL(response.url()).pathname !== '/api/chat' || response.request().method() !== 'POST') return;
        if (!seenRequest) return;
        record.httpStatus = response.status();
        record.responseType = response.headers()['content-type'] ?? null;
        try { capturedBody = await response.body(); } catch (e) { record.bodyError = String(e); }
      });
      await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const composer = page.locator('textarea[placeholder^="Ask "]');
      await composer.waitFor({ state: 'visible', timeout: 20000 });
      const assistant = page.locator('main').locator('div.break-words.text-zinc-100\\/95');
      const previous = await assistant.count();
      await composer.fill(c.message);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const start = Date.now();
      let lastHtml = '';
      let stableSince = 0;
      const timeout = c.timeoutMs ?? 150000;
      while (Date.now() - start < timeout) {
        const n = await assistant.count();
        if (n > previous) {
          const last = assistant.last();
          const html = await last.innerHTML();
          if (html !== lastHtml) {
            record.events.push({ tMs: Date.now() - start, html, text: await last.innerText() });
            lastHtml = html;
            stableSince = Date.now();
          }
          const sendReady = await page.getByRole('button', { name: 'Send', exact: true }).isVisible().catch(() => false);
          if (sendReady && stableSince && Date.now() - stableSince > 1200) break;
        }
        await page.waitForTimeout(250);
      }
      if (!record.events.length) throw new Error('No rendered assistant response observed before timeout');
      const last = assistant.last();
      record.rendered = await last.evaluate(el => ({
        html: el.innerHTML,
        text: el.textContent,
        tags: Object.fromEntries(['h1','h2','h3','strong','table','pre','code','ul','ol','blockquote'].map(tag => [tag, el.querySelectorAll(tag).length])),
      }));
      record.elapsedMs = Date.now() - start;
      record.success = !record.routingMismatch && record.httpStatus === 200 && record.events.length > 0;
      await page.screenshot({ path: pathPrefix + '.png', fullPage: true });
    } catch(e) {
      record.error = String(e);
      await page.screenshot({ path: pathPrefix + '-error.png', fullPage: true }).catch(()=>{});
    } finally {
      // Raw streamed provider response is evidence, not synthesized text.
      if (capturedBody) writeFileSync(pathPrefix + '.stream.bin', capturedBody);
      writeFileSync(pathPrefix + '.json', JSON.stringify(record, null, 2));
      results.push({ name: record.name, success: record.success, error: record.error,
        routingMismatch: record.routingMismatch, httpStatus: record.httpStatus, elapsedMs: record.elapsedMs });
      await page.close();
    }
  }
} finally { await browser.close(); }
writeFileSync(join(output, 'manifest.json'), JSON.stringify({
  capturedAt: new Date().toISOString(), origin: baseOrigin,
  results, reviewerStatus: 'NOT_REVIEWED', independentlyAccepted: false,
}, null, 2));
if (results.some(r => !r.success)) process.exitCode = 1;
console.log(JSON.stringify(results, null, 2));
