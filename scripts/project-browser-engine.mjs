import {chromium as playwright} from 'playwright-core';
import chromium from '@sparticuz/chromium';
import {accessSync,constants} from 'node:fs';
// Only the trusted parent of the browser namespace calls this. The extracted
// binary and its fonts are prepared on the CI runner before UID mapping;
// unprivileged child processes must never invoke tar/chown for /tmp/fonts.
export async function prepareTrustedChromium() {
  const executablePath = await chromium.executablePath();
  if(executablePath !== '/tmp/chromium')throw Error('Unexpected Chromium executable location');
  accessSync(executablePath,constants.X_OK);
  return executablePath;
}
import {validateContract} from './project-context.mjs';
const TOTAL_MS=150000;
export function localRequestAllowed(raw, origin, method = 'GET') {
  try {
    const url = new URL(raw);
    return url.origin === origin && !url.username && !url.password && ['http:','https:'].includes(url.protocol) && ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method);
  } catch { return false; }
}
export function platformToolbar(raw,type,deployed){try{const u=new URL(raw);return deployed&&type==='script'&&u.origin==='https://vercel.live'&&u.pathname==='/_next-live/feedback/feedback.js';}catch{return false;}}
export async function runScenarios(contract, origin, { executablePath, timeout = TOTAL_MS - 15_000, deployed = false, cookies = [], proxy } = {}) {
  validateContract(contract);
  const parsed = new URL(origin);
  if ((!deployed && (parsed.hostname !== '127.0.0.1' || parsed.protocol !== 'http:')) || (deployed && (parsed.protocol!=='https:' || !/^[a-z0-9-]+\.vercel\.app$/i.test(parsed.hostname))) || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw Error('Local browser origin required');
  let browser, timer;
  const checks = [];
  const deadline = Date.now() + timeout;
  try {
    // Keep the multi-process browser for isolated local CI. The Lambda-tuned
    // Chromium executable needs its packaged --single-process argument when
    // running inside Vercel. In that mode use a fresh browser per scenario:
    // recycling its contexts can terminate the entire serverless browser.
    const launch = async () => playwright.launch({
      executablePath: executablePath ?? await chromium.executablePath(),
      args: deployed ? chromium.args : chromium.args.filter(arg=>arg!=='--single-process'),
      ...(proxy?{proxy}:{}), headless: true,
      timeout: Math.min(20_000, Math.max(1,deadline-Date.now()))
    });
    if (!deployed) browser = await launch();
    timer = setTimeout(() => { void browser?.close().catch(() => {}); }, Math.max(1, deadline - Date.now()));
    for (const scenario of contract.scenarios) {
    if(deployed) browser = await launch();
    // Scenarios are independent test cases. Navigation within a scenario keeps
    // its storage, so reload persistence is tested without contaminating peers.
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false,...(deployed?{extraHTTPHeaders:{'x-vercel-skip-toolbar':'1'}}:{}) });
    if(cookies.length)await context.addCookies(cookies);
    let denied = [];
    await context.route('**/*', async route => {
      const request = route.request();
      if (!localRequestAllowed(request.url(), origin, request.method())) {
        // Vercel can inject its developer toolbar into a Preview even when
        // automation suppression is requested. Abort that exact platform script
        // too; it is not application functionality and never receives a request.
        if(!platformToolbar(request.url(),request.resourceType(),deployed))denied.push('External or unsupported request blocked');
        await route.abort('blockedbyclient');
      } else {
        // continue() lets Chromium follow redirects without another route hook.
        // Fetch one hop in Playwright, then fulfill it so the browser's next
        // request is independently checked before any bytes leave the process.
        try {
          const response = await route.fetch({ ...(deployed?{headers:{...request.headers(),'x-vercel-skip-toolbar':'1'}}:{}),maxRedirects: 0, timeout: Math.max(1, Math.min(deployed?20_000:10_000, deadline - Date.now())) });
          const location = response.headers().location;
          if (location && response.status() >= 300 && response.status() < 400 &&
              !localRequestAllowed(new URL(location, request.url()).href, origin, request.method())) {
            denied.push('External redirect blocked');
            await route.abort('blockedbyclient');
          } else await route.fulfill({ response });
        } catch {
          denied.push('Local request failed');
          await route.abort('failed').catch(() => {});
        }
      }
    });
    // WebSockets are unnecessary for acceptance and could bypass HTTP routing.
    await context.routeWebSocket('**/*', socket => { denied.push('WebSocket blocked'); socket.close(); });
      const page = await context.newPage();
      page.on('popup', popup => { denied.push('Unexpected popup blocked'); void popup.close(); });
      page.on('download', download => { denied.push('Unexpected download blocked'); void download.cancel(); });
      const stepTimeout = () => Math.max(1, Math.min(deployed?20_000:10_000, deadline - Date.now()));
      let assertions = 0;
      try {
        await page.goto(origin + contract.path, { waitUntil: 'domcontentloaded', timeout: stepTimeout() });
        for (const step of scenario.steps) {
          if (Date.now() >= deadline) throw Error('Total browser deadline exceeded');
          if (step.action === 'goto') await page.goto(origin + step.path, { waitUntil: 'domcontentloaded', timeout: stepTimeout() });
          else {
            const target = page.locator(step.selector);
            if (step.action === 'click') await target.click({ timeout: stepTimeout() });
            if (step.action === 'fill') await target.fill(step.value, { timeout: stepTimeout() });
            if (step.action === 'expectVisible' || step.action === 'expectText') {
              await target.waitFor({ state: 'visible', timeout: stepTimeout() });
              if (step.action === 'expectText') {
                // Retry actual rendered text without executing model-supplied JS.
                const until = Date.now() + stepTimeout();
                while ((await target.innerText({ timeout: stepTimeout() })).trim() !== step.value && Date.now() < until) await new Promise(r => setTimeout(r, 50));
                if ((await target.innerText({ timeout: stepTimeout() })).trim() !== step.value) throw Error('Rendered text does not equal approved expected value');
              }
              assertions++;
            }
          }
          if (!localRequestAllowed(page.url(), origin)) throw Error('Navigation escaped local origin');
        }
        if (!assertions || denied.length) throw Error(denied[0] ?? 'No assertions executed');
        checks.push({ name: scenario.name, passed: true, detail: `${assertions} rendered application assertion(s) passed` });
      } catch (error) { checks.push({ name: scenario.name, passed: false, detail: String(error.message).slice(0, 600) }); }
      finally {
        await context.close().catch(() => {});
        if(deployed) { await browser?.close().catch(()=>{}); browser=undefined; }
      }
    }
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
  }
  return checks;
}
