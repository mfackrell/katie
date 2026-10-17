import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { chromium as playwright } from 'playwright-core';
import chromium from '@sparticuz/chromium';
import { parseProjectContext, validateContract } from './project-context.mjs';

const TOTAL_MS = 150_000;
export function localRequestAllowed(raw, origin, method = 'GET') {
  try {
    const url = new URL(raw);
    return url.origin === origin && !url.username && !url.password && ['http:'].includes(url.protocol) && ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method);
  } catch { return false; }
}
export async function runScenarios(contract, origin, { executablePath, timeout = TOTAL_MS - 15_000 } = {}) {
  validateContract(contract);
  const parsed = new URL(origin);
  if (parsed.hostname !== '127.0.0.1' || parsed.protocol !== 'http:' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw Error('Local browser origin required');
  let browser, timer;
  const checks = [];
  const deadline = Date.now() + timeout;
  try {
    browser = await playwright.launch({ executablePath: executablePath ?? await chromium.executablePath(), args: chromium.args, headless: true, timeout: Math.min(20_000, timeout) });
    timer = setTimeout(() => { void browser.close().catch(() => {}); }, Math.max(1, deadline - Date.now()));
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    let denied = [];
    await context.route('**/*', async route => {
      const request = route.request();
      if (!localRequestAllowed(request.url(), origin, request.method())) {
        denied.push('External or unsupported request blocked');
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    // WebSockets are unnecessary for acceptance and could bypass HTTP routing.
    await context.routeWebSocket('**/*', socket => { denied.push('WebSocket blocked'); socket.close(); });
    for (const scenario of contract.scenarios) {
      denied = [];
      const page = await context.newPage();
      page.on('popup', popup => { denied.push('Unexpected popup blocked'); void popup.close(); });
      page.on('download', download => { denied.push('Unexpected download blocked'); void download.cancel(); });
      const stepTimeout = () => Math.max(1, Math.min(10_000, deadline - Date.now()));
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
      finally { await page.close().catch(() => {}); }
    }
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
  }
  return checks;
}
async function assertPortFree(port) {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  await new Promise(done => server.close(done));
}
export async function checkProject({ request, port, output }) {
  if (resolve(request) === resolve(output)) throw Error('Acceptance output must not overwrite the original request');
  const original = readFileSync(request, 'utf8');
  rmSync(output, { force: true }); // Never leave a previous run's passing artifact.
  const metadata = parseProjectContext(original);
  if (!metadata) return null; // Ordinary tasks make no acceptance claim or artifact.
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local port');
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
  if (!/^[a-f0-9]{40}$/.test(headSha)) throw Error('Invalid git HEAD');
  const report = { version: 1, projectId: metadata.projectId, contractHash: metadata.contractHash, headSha, passed: false, checks: [] };
  let server, timer, expired = false, logs = '';
  const started = Date.now();
  try {
    // Next automatically loads these files even with a sanitized environment.
    // A credential-bearing local checkout is not an acceptance sandbox.
    if (['.env', '.env.local', '.env.production', '.env.production.local'].some(file => existsSync(file))) throw Error('Refusing application env files in the acceptance checkout; use a clean CI worktree with placeholder credentials');
    execFileSync('git', ['merge-base', '--is-ancestor', metadata.baseSha, headSha], { stdio: 'pipe', timeout: 5000 });
    await assertPortFree(port);
    // Deliberate allowlist: never pass the workflow's provider/GitHub/database
    // credentials to application code under test. These are local placeholders.
    const env = {
      PATH: process.env.PATH, HOME: '/tmp', TMPDIR: '/tmp', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
      OPENAI_API_KEY: 'local-acceptance-placeholder', SUPABASE_SERVICE_ROLE_KEY: 'local-acceptance-placeholder',
      NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}`, SUPABASE_URL: `http://127.0.0.1:${port}`,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'local-acceptance-placeholder',
    };
    server = spawn(process.execPath, [resolve('node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    server.on('error', error => { logs = String(error.message).slice(0, 2000); });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
    const kill = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} };
    timer = setTimeout(() => { expired = true; kill(); }, TOTAL_MS);
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    while (Date.now() - started < 30_000 && server.exitCode === null) {
      try { const response = await fetch(origin + metadata.contract.path, { signal: AbortSignal.timeout(1500), redirect: 'manual' }); await response.body?.cancel(); if (/Ready in/u.test(logs) && server.exitCode === null) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    if (!ready) throw Error('Local Next application did not start');
    report.checks = await runScenarios(metadata.contract, origin, { timeout: TOTAL_MS - (Date.now() - started) - 5000 });
    const finalHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
    report.passed = !expired && finalHead === headSha && server.exitCode === null && report.checks.length === metadata.contract.scenarios.length && report.checks.every(c => c.passed);
  } catch (error) { report.checks.push({ name: 'browser runner', passed: false, detail: String(error.message).slice(0, 600) }); }
  finally {
    clearTimeout(timer);
    if (server?.pid) { try { process.kill(-server.pid, 'SIGKILL'); } catch {} await new Promise(done => { if (server.exitCode !== null || server.signalCode) done(); else server.once('exit', done); }); }
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== '--request' || args[2] !== '--port' || args[4] !== '--output') throw Error('Usage: project-browser-check.mjs --request ORIGINAL_AGENT_REQUEST.md --port 3109 --output project-acceptance.json');
    const report = await checkProject({ request: args[1], port: Number(args[3]), output: args[5] });
    if (report && !report.passed) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
