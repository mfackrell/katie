import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import bundledChromium from '@sparticuz/chromium';

// Run the real integrated workspace in a disposable Next project. All APIs and
// the owner-session module are test doubles; no real session or paid call exists.
test('standalone browser: explicit settings, scopes, exact approval resume, reduction review, cancellation and reload', { timeout: 170000 }, async () => {
  const root = resolve('.'), project = await mkdtemp(join(tmpdir(), 'standalone-next-'));
  const screenshots = await mkdtemp(join(tmpdir(), 'standalone-browser-evidence-'));
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(done => socket.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const actorId = '22222222-2222-4222-8222-222222222222', chatId = '33333333-3333-4333-8333-333333333333';
  let server, browser, output = '';
  const totals = overrides => ({ inputTokens: 123, outputTokens: 45, missingInputCount: 0, missingOutputCount: 1, estimatedCostMicrousd: '250000', pendingExposureMicrousd: '900000', uncertainExposureMicrousd: '100000', unknownCostCount: 1, attemptCount: 4, ...overrides });
  const pending = (suffix, overrides = {}) => ({ id: `attempt-${suffix}`, requestId: `original-${suffix}`, provider: 'openai', model: 'gpt-4o', resolvedModel: null, category: 'hidden_router', preparedHash: 'a'.repeat(64), pricingVersion: 'fixture-pricing-v1', estimatorVersion: 'saved-estimator-v1', budgetRevision: 1, reservedMicrousd: '300000', reason: 'Choose a reply model for this saved turn.', pauseReason: 'per_call_threshold', tradeoffs: null, createdAt: '2026-10-28T10:00:00Z', preview: { textBytes: 3200, imageCount: 2, imageBytes: 4096, inputTokens: 3500, imageTokens: 256, outputAllowance: 8192, assumptions: ['Input token count is an estimate, not a guaranteed spending ceiling.', 'All allowed output tokens include hidden reasoning.'], issues: [], status: 'estimated' }, requestExposure: totals(), ...overrides });
  let configuration = null, proposals = [], running = [], fail = false, resumeMode = 'paused', savedMessages = [];
  const decisions = [], resumes = [], configurations = [], scopes = [], external = [], unknownRoutes = [], errors = [], messageSnapshots = [];
  let page;
  try {
    await mkdir(join(project, 'app/conversations/[id]'), { recursive: true });
    await symlink(join(root, 'node_modules'), join(project, 'node_modules'), 'dir');
    await writeFile(join(project, 'package.json'), JSON.stringify({ private: true }));
    await writeFile(join(project, 'next.config.mjs'), `export default {experimental:{externalDir:true},webpack(config){config.resolve.alias={...config.resolve.alias,'@/lib/tools/browser-owner-session$':${JSON.stringify(join(project, 'owner-session.ts'))},'@':${JSON.stringify(root)}};return config;}};`);
    await writeFile(join(project, 'postcss.config.mjs'), 'export default {plugins:{tailwindcss:{}}};');
    await writeFile(join(project, 'tailwind.config.mjs'), `export default {darkMode:['class'],content:[${JSON.stringify(root + '/components/**/*.{ts,tsx}')},${JSON.stringify(root + '/lib/**/*.{ts,tsx}')}],theme:{extend:{}},plugins:[]};`);
    await writeFile(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['dom', 'dom.iterable', 'esnext'], strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', jsx: 'preserve', resolveJsonModule: true, baseUrl: '.', paths: { '@/lib/tools/browser-owner-session': ['./owner-session.ts'], '@/*': [root + '/*'] } }, include: ['**/*.ts', '**/*.tsx'] }));
    await writeFile(join(project, 'owner-session.ts'), "'use client'; export function browserOwnerAuth(){return null;} export async function ownerSessionBearer(){return 'synthetic-browser-owner';}");
    await writeFile(join(project, 'app/layout.tsx'), `import ${JSON.stringify(root + '/app/globals.css')}; import {ApplicationShell} from '@/components/application-shell'; export default function Layout({children}:{children:React.ReactNode}){return <html lang="en" className="dark"><body><ApplicationShell>{children}</ApplicationShell></body></html>;}`);
    await writeFile(join(project, 'app/conversations/[id]/page.tsx'), `import ChatWorkspace from '@/components/chat-workspace'; export default function Page(){return <ChatWorkspace conversationId=${JSON.stringify(chatId)}/>;}`);
    server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: project, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000); });
    const deadline = Date.now() + 65000;
    while (!output.includes('Ready in')) {
      if (server.exitCode !== null || Date.now() > deadline) throw Error('Disposable Next server did not start: ' + output);
      await new Promise(done => setTimeout(done, 100));
    }
    browser = await chromium.launch({ executablePath: process.env.KATIE_TEST_CHROMIUM || await bundledChromium.executablePath(), args: bundledChromium.args, headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.__accountingResumeEvents = []; window.addEventListener('standalone-accounting-resume', event => window.__accountingResumeEvents.push(event.detail)); });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(request.url()); return route.abort('blockedbyclient'); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const body = request.postData() ? request.postDataJSON() : null;
      const reply = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname.startsWith('/api/standalone-accounting/')) {
        assert.equal(request.headers().authorization, 'Bearer synthetic-browser-owner');
        if (url.pathname.endsWith('/usage')) {
          scopes.push(url.searchParams.get('scope'));
          if (fail) return reply({ error: 'Fixture accounting unavailable' }, 503);
          const all = url.searchParams.get('scope') === 'all';
          const sum = totals(all ? { inputTokens: 999, estimatedCostMicrousd: '750000' } : {});
          return reply({ configuration, pending: proposals, active: running, daily: configuration ? { timezone: configuration.timezone, date: '2026-10-28', start: '2026-10-28T00:00:00Z', end: '2026-10-29T00:00:00Z', totals: sum, providers: [{ ...sum, provider: 'openai' }], models: [{ ...sum, provider: 'openai', model: 'gpt-4o', category: 'hidden_router' }], unresolvedEarlier: totals({ attemptCount: 1, pendingExposureMicrousd: '0', uncertainExposureMicrousd: '40000' }), attempts: [{ id: 'helper-row', actor_id: actorId, chat_id: chatId, provider: 'openai', model: 'gpt-4o', category: 'hidden_router', state: 'uncertain', created_at: '2026-10-28T10:00:00Z', dispatched_at: '2026-10-28T10:00:00Z', actual_microusd: null }] } : null });
        }
        if (url.pathname.endsWith('/configuration')) {
          configurations.push(body); configuration = { timezone: body.timezone, per_call_limit_microusd: body.perCallLimitMicrousd, request_limit_microusd: body.requestLimitMicrousd, budget_revision: 1 };
          proposals = [pending('approve'), pending('reduce'), pending('cancel')];
          return reply({ configuration });
        }
        if (url.pathname.endsWith('/attempts')) {
          decisions.push(body); const original = [...proposals, ...running].find(attempt => attempt.id === body.attemptId); assert.ok(original);
          assert.equal(body.preparedHash, original.preparedHash); assert.equal(body.reservedMicrousd, original.reservedMicrousd);
          if (body.action === 'cancel' && running.some(attempt => attempt.id === original.id)) {
            running = running.filter(attempt => attempt.id !== original.id);
            return reply({ attemptId: original.id, requestId: original.requestId, state: 'uncertain', cancellationRequested: true, heldExposureMicrousd: original.reservedMicrousd, message: 'Cancellation requested for remaining work. This attempt was already dispatched; its spending exposure remains held until provider usage is reconciled.' });
          }
          if (body.action === 'reduce_cost') proposals = proposals.map(attempt => attempt.id === original.id ? pending('revised', { requestId: original.requestId, reservedMicrousd: '120000', preparedHash: 'b'.repeat(64), pauseReason: 'cost_reduction_review', tradeoffs: 'Older context was omitted. A smaller output allowance can shorten the answer.', preview: { ...attempt.preview, outputAllowance: 2048 } }) : attempt);
          else { proposals = proposals.filter(attempt => attempt.id !== original.id); if (body.action === 'approve_once') running.push({ ...original, state: 'dispatched' }); }
          return reply({ attemptId: original.id, requestId: original.requestId, state: body.action === 'approve_once' ? 'reserved' : body.action === 'cancel' ? 'cancelled' : 'paused', ...(body.action === 'cancel' ? { cancellationRequested: true, message: 'Attempt cancelled before dispatch.' } : {}) });
        }
      }
      if (url.pathname === '/api/chat') {
        const requestId = request.headers()['x-request-id']; resumes.push({ body, requestId });
        running = running.map(attempt => attempt.requestId === requestId && attempt.state === 'reserved' ? { ...attempt, state: 'dispatched' } : attempt);
        if (resumeMode === 'failed') return reply({ error: 'Saved attempt failed: exact fixture cause' }, 500);
        if (resumeMode === 'completed') { savedMessages = [{ id: 'saved-answer', role: 'assistant', content: 'The saved approved answer is visible.', createdAt: '2026-10-28T10:00:00Z', provider: 'openai', model: 'gpt-4o' }]; return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'content', text: savedMessages[0].content }) + '\n' }); }
        return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'accounting_pause', code: 'standalone_approval_required', message: 'Supporting work paused: per_request_threshold' }) + '\n' });
      }
      if (url.pathname === '/api/actors') return reply({ actors: [{ id: actorId, name: 'Fixture standalone', purpose: 'Browser verification', actorKind: 'standard' }] });
      if (url.pathname === '/api/chats') return reply({ chats: [{ id: chatId, actorId, title: 'Synthetic saved conversation', createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z' }] });
      if (url.pathname === '/api/admin/repos') return reply({ repos: [] });
      if (url.pathname === '/api/ui-state') return reply({ state: { key: body?.key ?? url.searchParams.get('key'), version: 1, value: body?.value ?? {} } });
      if (url.pathname === '/api/messages') { messageSnapshots.push({ api: 'messages', ids: savedMessages.map(message => message.id) }); return reply({ messages: savedMessages }); }
      if (url.pathname === '/api/message-reactions') return reply({ reactions: {} });
      if (url.pathname === '/api/projects') { messageSnapshots.push({ api: 'projects', ids: savedMessages.map(message => message.id) }); return reply({ active: false, status: null, approval: null, resourceRecovery: null, messages: savedMessages }); }
      if (url.pathname === '/api/work') return reply({ items: [], warnings: [] });
      if (url.pathname === '/api/long-term-memory') return reply({ content: { entries: [] }, documents: [] });
      if (url.pathname === '/api/models') return reply({ openai: ['gpt-4o'] });
      if (url.pathname === '/api/version') return reply({ version: 'fixture-browser' });
      unknownRoutes.push(url.pathname); return reply({ error: 'Unexpected fixture API' }, 404);
    });
    await page.goto(`${origin}/conversations/${chatId}`, { waitUntil: 'domcontentloaded', timeout: 65000 });
    const usage = page.getByRole('region', { name: 'Standalone daily usage' });
    await usage.getByRole('button', { name: 'Set budget settings' }).click();
    assert.equal(await usage.getByLabel('Timezone (IANA)').inputValue(), '');
    assert.equal(await usage.getByLabel('Per call approval threshold (USD)').inputValue(), '');
    assert.equal(await usage.getByLabel('Per request approval threshold (USD)').inputValue(), '');
    await page.screenshot({ path: join(screenshots, 'unconfigured-desktop.png'), fullPage: true });
    await usage.getByLabel('Timezone (IANA)').fill('America/New_York');
    await usage.getByLabel('Per call approval threshold (USD)').fill('0.01');
    await usage.getByLabel('Per request approval threshold (USD)').fill('0.05');
    await usage.getByRole('button', { name: 'Save settings' }).click();
    await usage.getByText('Today $0.25', { exact: false }).waitFor();
    await usage.getByText('Earlier unresolved exposure', { exact: false }).waitFor();
    assert.equal(configurations[0].perCallLimitMicrousd, '10000'); assert.equal(configurations[0].requestLimitMicrousd, '50000');
    assert.match(await usage.innerText(), /Out 45 \+ unknown \(1\)/);
    assert.match(await usage.innerText(), /Earlier unresolved exposure.*uncertain \$0.04/);
    await usage.getByRole('button', { name: 'Review', exact: true }).click();
    assert.match(await usage.innerText(), /Purpose: Choose a reply model/);
    assert.match(await usage.innerText(), /resolved model: not yet known/);
    assert.match(await usage.innerText(), /estimator saved-estimator-v1/);
    await usage.getByRole('button', { name: 'Usage details' }).click();
    await usage.getByLabel('Scope').selectOption('all');
    await usage.getByText('Today $0.75', { exact: false }).waitFor();
    assert.ok(scopes.includes('this-agent') && scopes.includes('all'));
    await usage.getByLabel('Scope').selectOption('this-agent');
    await usage.getByText('Today $0.25', { exact: false }).waitFor();
    await usage.getByText('Models & activity, including hidden helpers', { exact: false }).click();
    assert.match(await usage.getByRole('table').innerText(), /hidden_router/);
    await usage.getByRole('button', { name: 'Close details' }).click();
    await usage.getByRole('button', { name: 'Review', exact: true }).click();
    const card = id => usage.locator('div.rounded.border').filter({ hasText: `Exact attempt ${id} ·` });
    const resumedResponse = page.waitForResponse(response => response.url().endsWith('/api/chat'));
    await card('attempt-approve').getByRole('button', { name: 'Approve once' }).click();
    await page.waitForFunction(() => window.__accountingResumeEvents.length === 1);
    await resumedResponse;
    assert.equal(resumes.length, 1);
    assert.deepEqual(resumes[0], { body: { actorId, chatId, standaloneResume: true }, requestId: 'original-approve' });
    assert.equal(resumes[0].body.message, undefined, 'approval resumes durable original input instead of creating a generic message');
    await usage.getByRole('alert').filter({ hasText: 'Supporting work paused: per_request_threshold' }).waitFor();
    assert.match(await usage.innerText(), /Supporting work paused: per_request_threshold/);
    assert.doesNotMatch(await usage.innerText(), /Resume requested|Approved saved work completed/);
    const active = usage.getByLabel('Active attempts in this conversation');
    await active.getByRole('button', { name: 'Cancel remaining work' }).waitFor();
    assert.match(await active.innerText(), /Already dispatched/);
    assert.equal(await active.getByRole('button', { name: 'Resume saved work' }).count(), 0, 'dispatched work cannot be replayed');
    await page.screenshot({ path: join(screenshots, 'active-cancellation-desktop.png'), fullPage: true });
    const approvalsBeforeCancel = decisions.filter(body => body.action === 'approve_once').length;
    await active.getByRole('button', { name: 'Cancel remaining work' }).click();
    await usage.getByRole('status').filter({ hasText: 'spending exposure remains held' }).waitFor();
    assert.equal(resumes.length, 1, 'cancelling running work must not resume or start another provider attempt');
    assert.equal(decisions.filter(body => body.action === 'approve_once').length, approvalsBeforeCancel, 'active cancellation never approves');
    await active.waitFor({ state: 'detached' });
    await card('attempt-reduce').getByRole('button', { name: 'Reduce cost' }).click();
    await usage.getByText('Reduction tradeoffs:', { exact: false }).waitFor();
    assert.equal(resumes.length, 1, 'cost reduction cannot dispatch');
    assert.match(await card('attempt-revised').innerText(), /configured output allowance 2,048/);
    assert.equal(await card('attempt-revised').getByRole('button', { name: 'Approve once' }).count(), 1);
    await card('attempt-cancel').getByRole('button', { name: 'Cancel', exact: true }).click();
    await usage.getByText('Attempt cancelled before dispatch.', { exact: true }).waitFor();
    assert.deepEqual(decisions.map(body => body.action), ['approve_once', 'cancel', 'reduce_cost', 'cancel']);
    assert.equal(resumes.length, 1, 'cancel cannot dispatch');
    await page.setViewportSize({ width: 390, height: 844 });
    await card('attempt-revised').getByRole('button', { name: 'Approve once' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(screenshots, 'reduction-mobile.png'), fullPage: true });
    const actionBounds = await card('attempt-revised').getByRole('button', { name: 'Approve once' }).boundingBox();
    assert.ok(actionBounds && actionBounds.y >= 0 && actionBounds.y + actionBounds.height <= 844, 'mobile approval action is reachable in the scroll viewport');
    // Simulate approval having committed before a disconnected tab could emit resume.
    running = [{ ...pending('reconnect'), requestId: 'original-approved-reconnect', state: 'reserved' }];
    const approvalCountBeforeReconnect = decisions.filter(body => body.action === 'approve_once').length;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await usage.getByRole('button', { name: 'Review', exact: true }).click();
    await usage.getByText('Reduction tradeoffs:', { exact: false }).waitFor();
    assert.equal(resumes.length, 1, 'reload cannot replay approval or start a model');
    await active.getByRole('button', { name: 'Resume saved work' }).waitFor();
    await active.getByRole('button', { name: 'Resume saved work' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(screenshots, 'reserved-reconnect-mobile.png'), fullPage: true });
    resumeMode = 'completed';
    const reconnectResponse = page.waitForResponse(response => response.url().endsWith('/api/chat'));
    const savedProjectRefresh = page.waitForResponse(async response => response.url().includes('/api/projects?') && (await response.json()).messages.some(message => message.id === 'saved-answer'));
    await active.getByRole('button', { name: 'Resume saved work' }).click();
    await reconnectResponse;
    assert.equal(resumes.length, 2);
    // Both persisted-message APIs represent the same server snapshot. Wait for
    // the post-resume project refresh too, so this assertion cannot win a race
    // against an inconsistent fixture overwriting the newly loaded answer.
    await savedProjectRefresh;
    await page.getByText('The saved approved answer is visible.', { exact: true }).waitFor();
    await usage.getByRole('status').filter({ hasText: 'Saved work completed.' }).waitFor();
    assert.deepEqual(resumes[1], { body: { actorId, chatId, standaloneResume: true }, requestId: 'original-approved-reconnect' });
    assert.equal(decisions.filter(body => body.action === 'approve_once').length, approvalCountBeforeReconnect, 'resuming a reserved attempt must not issue another approval');
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Resume saved work'));
    running = running.map(attempt => ({ ...attempt, state: 'uncertain' }));
    await usage.getByRole('button', { name: 'Usage details' }).click();
    await usage.getByRole('button', { name: 'Refresh', exact: true }).click();
    await usage.getByRole('button', { name: 'Review', exact: true }).click();
    await active.getByText('openai/gpt-4o · hidden_router · uncertain', { exact: false }).waitFor();
    assert.equal(await active.getByRole('button', { name: 'Resume saved work' }).count(), 0, 'uncertain paid work cannot be replayed');
    assert.equal(await active.getByRole('button', { name: 'Cancel remaining work' }).count(), 1);
    running = [{ ...pending('failed'), state: 'reserved' }]; resumeMode = 'failed';
    await usage.getByRole('button', { name: 'Usage details' }).click();
    await usage.getByRole('button', { name: 'Refresh', exact: true }).click();
    await usage.getByRole('button', { name: 'Review', exact: true }).click();
    await active.getByRole('button', { name: 'Resume saved work' }).click();
    await usage.getByRole('alert').filter({ hasText: 'Saved attempt failed: exact fixture cause' }).waitFor();
    await usage.getByRole('button', { name: 'Usage details' }).click();
    await usage.getByRole('button', { name: 'Refresh', exact: true }).click();
    assert.match(await usage.innerText(), /Saved attempt failed: exact fixture cause/);
    assert.doesNotMatch(await usage.innerText(), /Resume requested|Saved work completed/);
    assert.equal(resumes.length, 3);
    fail = true; await usage.getByRole('button', { name: 'Refresh', exact: true }).click();
    await usage.getByRole('alert').filter({ hasText: 'Previously loaded values may be stale' }).waitFor();
    assert.match(await usage.innerText(), /Saved attempt failed: exact fixture cause/);
    assert.deepEqual(external, []); assert.deepEqual(unknownRoutes, []); assert.deepEqual(errors, []);
    console.log('Standalone browser screenshots: ' + screenshots);
  } catch (error) {
    const visible = await page?.locator('body').innerText().catch(() => 'Browser unavailable');
    throw new Error(`${error.message}\nPersisted message snapshots: ${JSON.stringify(messageSnapshots)}\nBrowser errors: ${JSON.stringify(errors)}\nVisible UI:\n${visible}\nDisposable Next output:\n${output}`, { cause: error });
  } finally {
    await browser?.close();
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([once(server, 'exit'), new Promise(done => setTimeout(done, 4000))]); if (server.exitCode === null) server.kill('SIGKILL'); }
    await rm(project, { recursive: true, force: true });
  }
});
