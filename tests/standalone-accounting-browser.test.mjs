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
  const screenshots = process.env.CI ? join(root, 'test-artifacts/standalone-rail') : await mkdtemp(join(tmpdir(), 'standalone-browser-evidence-'));
  await mkdir(screenshots, { recursive: true });
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(done => socket.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const actorId = '22222222-2222-4222-8222-222222222222', chatId = '33333333-3333-4333-8333-333333333333';
  let server, browser, output = '';
  const totals = overrides => ({ inputTokens: 123, outputTokens: 45, missingInputCount: 0, missingOutputCount: 1, estimatedCostMicrousd: '250000', pendingExposureMicrousd: '900000', uncertainExposureMicrousd: '100000', unknownCostCount: 1, attemptCount: 4, ...overrides });
  const pending = (suffix, overrides = {}) => ({ parentStatus:'paused', continuationActionable:true, cancellationActionable:true, id: `attempt-${suffix}`, requestId: `original-${suffix}`, provider: 'openai', model: 'gpt-4o', resolvedModel: null, category: 'hidden_router', preparedHash: 'a'.repeat(64), pricingVersion: 'fixture-pricing-v1', estimatorVersion: 'saved-estimator-v1', budgetRevision: 1, reservedMicrousd: '300000', reason: 'Choose a reply model for this saved turn.', pauseReason: 'per_call_threshold', tradeoffs: null, createdAt: '2026-10-28T10:00:00Z', preview: { textBytes: 3200, imageCount: 2, imageBytes: 4096, inputTokens: 3500, imageTokens: 256, outputAllowance: 8192, assumptions: ['Input token count is an estimate, not a guaranteed spending ceiling.', 'All allowed output tokens include hidden reasoning.'], issues: [], status: 'estimated' }, requestExposure: totals(), ...overrides });
  let configuration = null, proposals = [], running = [], fail = false, resumeMode = 'paused', savedMessages = [], denyExposure = false, uncertainTotal = '100000', infrastructureTotal = '0';
  const decisions = [], resumes = [], configurations = [], scopes = [], external = [], unknownRoutes = [], errors = [], messageSnapshots = [];
  let workPage={next:null},pagedApprovals=false;
  let page;let holdUsage=false;const heldUsage=[];let usageRequests=0,usageInFlight=0,maxUsageInFlight=0;
  const usageRequestIds=new Set();
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
    page.on('request',request=>{if(new URL(request.url()).pathname==='/api/standalone-accounting/usage'){usageRequestIds.add(request);usageRequests++;usageInFlight++;maxUsageInFlight=Math.max(maxUsageInFlight,usageInFlight);}});
    const usageFinished=request=>{if(usageRequestIds.delete(request))usageInFlight--;};
    page.on('requestfinished',usageFinished);page.on('requestfailed',usageFinished);
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
          if(holdUsage){await new Promise(resolve=>heldUsage.push(resolve));if(request.failure())return route.abort().catch(()=>{});}
          if(pagedApprovals&&url.searchParams.get('before')){proposals=[pending('older-paused')];workPage={next:null};}
          scopes.push(url.searchParams.get('scope'));
          if (fail) return reply({ error: 'Fixture accounting unavailable' }, 503);
          const all = url.searchParams.get('scope') === 'all';
          const sum = totals({ uncertainExposureMicrousd: uncertainTotal, estimatedInfrastructureMicrousd: infrastructureTotal, ...(all ? { inputTokens: 999, estimatedCostMicrousd: '750000' } : {}) });
          const infra = totals({ inputTokens:0, outputTokens:0, missingInputCount:0, missingOutputCount:0, estimatedCostMicrousd:'0', estimatedInfrastructureMicrousd:infrastructureTotal, pendingExposureMicrousd:'0', uncertainExposureMicrousd:'0', unknownCostCount:1, attemptCount:1 });
          const infrastructureModels = infrastructureTotal === '0' ? [] : [{ ...infra, provider:'runpod', model:'Qwen/Qwen3-VL-8B-Instruct', category:'attachment-observation' }];
          return reply({ workPage, configuration, pending: proposals, active: running, daily: configuration ? { timezone: configuration.timezone, date: '2026-10-28', start: '2026-10-28T00:00:00Z', end: '2026-10-29T00:00:00Z', totals: sum, providers: [{ ...sum, estimatedInfrastructureMicrousd:'0', provider: 'openai' }, ...infrastructureModels], models: [{ ...sum, estimatedInfrastructureMicrousd:'0', provider: 'openai', model: 'gpt-4o', category: 'hidden_router' }, ...infrastructureModels], unresolvedEarlier: totals({ attemptCount: 1, pendingExposureMicrousd: '0', uncertainExposureMicrousd: '40000' }), attempts: [{ id: 'helper-row', actor_id: actorId, chat_id: chatId, provider: 'openai', model: 'gpt-4o', category: 'hidden_router', state: 'uncertain', created_at: '2026-10-28T10:00:00Z', dispatched_at: '2026-10-28T10:00:00Z', actual_microusd: null }] } : null });
        }
        if (url.pathname.endsWith('/configuration')) {
          configurations.push(body); configuration = { timezone: body.timezone, per_call_limit_microusd: body.perCallLimitMicrousd, request_limit_microusd: body.requestLimitMicrousd, budget_revision: 1 };
          proposals = [pending('approve'), pending('reduce'), pending('cancel')];
          return reply({ configuration });
        }
        if (url.pathname.endsWith('/attempts')) {
          decisions.push(body); const original = [...proposals, ...running].find(attempt => attempt.id === body.attemptId); assert.ok(original);
          assert.equal(body.preparedHash, original.preparedHash); assert.equal(body.reservedMicrousd, original.reservedMicrousd);
          if (body.action === 'accept_exposure') {
            assert.equal(original.state, 'uncertain');
            assert.equal(body.budgetRevision, configuration.budget_revision, 'acceptance uses current owner budget revision');
            if (denyExposure) return reply({ error: 'This owner cannot accept the uncertain exposure.' }, 403);
            running = running.map(attempt => attempt.id === original.id ? { ...attempt, exposureAccepted: true } : attempt);
            return reply({ attemptId: original.id, requestId: original.requestId, state: 'uncertain', retainedExposureMicrousd: original.reservedMicrousd });
          }
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
        if (resumeMode === 'completed') { const qwenPoll=running.some(attempt=>attempt.requestId===requestId && attempt.pollableRunpod); if (qwenPoll) {running=[]; infrastructureTotal='20000';} savedMessages = [{ id: 'saved-answer', role: 'assistant', content: 'The saved approved answer is visible.', createdAt: '2026-10-28T10:00:00Z', provider: 'openai', model: 'gpt-4o' }]; const stages=qwenPoll?['Analyzing image with Qwen…','Qwen image analysis queued…','Qwen image analysis complete','Using saved Qwen observation']:[]; return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: [...stages.map(imageObservation=>({type:'metadata',imageObservation})),{ type: 'content', text: savedMessages[0].content }].map(chunk=>JSON.stringify(chunk)).join('\n') + '\n' }); }
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
    const rail = page.getByRole('complementary', { name: 'Katie status rail' });
    await rail.waitFor();
    const assertDesktopLayout = async () => {
      const railBox = await rail.boundingBox();
      const chatBox = await page.locator('main').last().boundingBox();
      const composerBox = await page.locator('main textarea').last().boundingBox();
      const up = await page.getByRole('button', { name: 'Scroll to top' }).boundingBox();
      const down = await page.getByRole('button', { name: 'Scroll to bottom' }).boundingBox();
      assert.ok(railBox && railBox.width >= 300 && railBox.width <= 390, 'rail must be 320-380px approximately');
      assert.ok(chatBox && chatBox.width > railBox.width && chatBox.height > 600, 'chat must retain dominant viewport');
      assert.ok(composerBox && composerBox.y >= 0 && composerBox.y + composerBox.height <= 1100, 'composer remains onscreen');
      assert.ok(up && down && up.y >= 0 && down.y + down.height <= 1100, 'chat navigation is visible');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(overflow, false, 'no horizontal page overflow');
    };
    await assertDesktopLayout();
    await page.screenshot({ path: join(screenshots, 'status-rail-open-desktop.png'), fullPage: false });
    await rail.getByRole('button', { name: 'Hide', exact: true }).click();
    await rail.waitFor({ state: 'detached' });
    assert.ok((await page.locator('main').last().boundingBox()).width > 900, 'collapsed rail expands chat');
    await page.screenshot({ path: join(screenshots, 'status-rail-collapsed-desktop.png'), fullPage: false });
    await page.getByRole('button', { name: 'Status / Usage', exact: true }).click();
    await rail.waitFor();
    await assertDesktopLayout();


    await usage.getByRole('button', { name: 'Budget & timezone' }).click();
    assert.equal(await usage.getByLabel('Timezone (IANA)').inputValue(), '');
    assert.equal(await usage.getByLabel('Per call approval threshold (USD)').inputValue(), '');
    assert.equal(await usage.getByLabel('Per request approval threshold (USD)').inputValue(), '');
    await page.screenshot({ path: join(screenshots, 'unconfigured-desktop.png'), fullPage: true });
    await usage.getByLabel('Timezone (IANA)').fill('America/New_York');
    await usage.getByLabel('Per call approval threshold (USD)').fill('0.01');
    await usage.getByLabel('Per request approval threshold (USD)').fill('0.05');
    await usage.getByRole('button', { name: 'Save settings' }).click();
    await usage.getByText('$0.25', { exact: true }).first().waitFor();
    // Provider tooltip exposes only that provider's model statistics.
    const providerTooltip = usage.getByRole('tooltip');
    await usage.getByRole('button', { name: 'Show model usage for openai' }).hover();
    await providerTooltip.waitFor();
    assert.match(await providerTooltip.innerText(), /gpt-4o/);
    await page.mouse.move(0, 0);
    // The same rail usage snapshot must make approval actionable in the chat,
    // without mounting a second usage reader or a second polling flight.
    const inlineApproval = page.getByRole('region', { name: 'Spending authorization required' });
    await inlineApproval.getByRole('button', { name: 'Approve selected model once' }).first().waitFor();
    assert.match(await inlineApproval.innerText(), /Estimated reservation:.*\$0\.3/);
    await page.screenshot({ path: join(screenshots, 'status-rail-multiple-approvals-desktop.png'), fullPage: false });
    await assertDesktopLayout();
    await usage.getByText('Models, activity & earlier exposure').click();
    await usage.getByText('Earlier unresolved exposure', { exact: false }).waitFor();
    assert.equal(configurations[0].perCallLimitMicrousd, '10000'); assert.equal(configurations[0].requestLimitMicrousd, '50000');
    assert.match(await usage.innerText(), /Out 45 \+ unknown \(1\)/);
    assert.match(await usage.innerText(), /Earlier unresolved exposure.*uncertain \$0.04/);
    // All approvals remain visible in the rail.
    assert.match(await usage.innerText(), /Purpose: Choose a reply model/);
    assert.match(await usage.innerText(), /resolved model: not yet known/);
    assert.match(await usage.innerText(), /estimator saved-estimator-v1/);
    // Usage details are directly accessible in the rail.
    await usage.getByLabel('Scope').selectOption('all');
    await usage.getByText('$0.75', { exact: true }).first().waitFor();
    assert.ok(scopes.includes('this-agent') && scopes.includes('all'));
    await usage.getByLabel('Scope').selectOption('this-agent');
    await usage.getByText('$0.25', { exact: true }).first().waitFor();
    await usage.getByText('Models & activity, including hidden helpers', { exact: false }).click();
    assert.match(await usage.getByRole('table').innerText(), /hidden_router/);
    // Usage remains available in the rail.
    // All approvals remain visible in the rail.
    const card = id => usage.locator('div.rounded.border').filter({ hasText: `Exact attempt ${id} ·` });
    const resumedResponse = page.waitForResponse(response => response.url().endsWith('/api/chat'));
    await card('attempt-approve').getByRole('button', { name: 'Approve once' }).click();
    await page.waitForFunction(() => window.__accountingResumeEvents.length === 1);
    await resumedResponse;
    assert.equal(resumes.length, 1);
    assert.deepEqual(resumes[0], { body: { actorId, chatId, standaloneResume: true }, requestId: 'original-approve' });
    assert.equal(resumes[0].body.message, undefined, 'approval resumes durable original input instead of creating a generic message');
    await usage.getByRole('alert').filter({ hasText: 'Supporting work paused: per_request_threshold' }).waitFor();
    await page.screenshot({ path: join(screenshots, 'status-rail-resume-paused-desktop.png'), fullPage: false });
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
    // All approvals remain visible in the rail.
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
    running = running.map(attempt => ({ ...attempt, state: 'uncertain', reservedMicrousd: '3584', exposureAccepted: false }));
    configuration = { ...configuration, budget_revision: 2 }; uncertainTotal = '3584';
    // Usage details are directly accessible in the rail.
    await usage.getByRole('button', { name: 'Refresh', exact: true }).click();
    // All approvals remain visible in the rail.
    await active.getByText('openai/gpt-4o · hidden_router · uncertain', { exact: false }).waitFor();
    assert.equal(await active.getByRole('button', { name: 'Resume saved work' }).count(), 0, 'uncertain paid work cannot be replayed');
    assert.equal(await active.getByRole('button', { name: 'Cancel remaining work' }).count(), 1);
    assert.equal(await active.getByRole('button', { name: 'Approve once' }).count(), 0);
    assert.match(await active.innerText(), /provider call was already sent.*will not resend this attempt/);
    denyExposure = true;
    await active.getByRole('button', { name: 'Accept exposure & continue', exact: true }).click();
    await usage.getByRole('alert').filter({ hasText: 'This owner cannot accept the uncertain exposure.' }).waitFor();
    assert.equal(resumes.length, 2, 'denied authorization cannot resume');
    assert.doesNotMatch(await active.innerText(), /Uncertain exposure accepted/);
    denyExposure = false; resumeMode = 'failed';
    await active.getByRole('button', { name: 'Accept exposure & continue', exact: true }).click();
    await usage.getByRole('alert').filter({ hasText: 'Saved attempt failed: exact fixture cause' }).waitFor();
    await active.getByText('Uncertain exposure accepted · $0.003584 retained', { exact: true }).waitFor();
    assert.match(await usage.innerText(), /Uncertain exposure accepted.*retained.*continuation stopped/);
    assert.equal(running[0].state, 'uncertain'); assert.equal(running[0].reservedMicrousd, '3584');
    assert.equal(decisions.filter(body => body.action === 'accept_exposure').at(-1).budgetRevision, 2);
    assert.equal(resumes.length, 3);
    await page.reload({ waitUntil: 'domcontentloaded' });
    // All approvals remain visible in the rail.
    await active.getByText('Uncertain exposure accepted · $0.003584 retained', { exact: true }).waitFor();
    assert.equal(resumes.length, 3, 'reconnect must not automatically resume uncertain work');
    resumeMode = 'completed';
    await active.getByRole('button', { name: 'Continue remaining work', exact: true }).click();
    await usage.getByRole('status').filter({ hasText: 'Uncertain exposure accepted · $0.003584 retained · remaining work completed' }).waitFor();
    assert.equal(running[0].state, 'uncertain'); assert.equal(running[0].reservedMicrousd, '3584');
    assert.equal(resumes.length, 4);
    // Usage details are directly accessible in the rail.
    const dailySpendTiles = usage.getByLabel('Daily spending summary');
    assert.match(await dailySpendTiles.innerText(), /Uncertain\s+\$0\.00/);
    // The approval receipt remains exact even though the overview rounds to cents.
    assert.match(await active.innerText(), /Uncertain exposure accepted · \$0\.003584 retained/);
    // Usage remains available in the rail.
    running = [{ ...pending('failed'), state: 'reserved' }]; resumeMode = 'failed';
    // Usage details are directly accessible in the rail.
    await usage.getByRole('button', { name: 'Refresh', exact: true }).click();
    // All approvals remain visible in the rail.
    await active.getByRole('button', { name: 'Resume saved work' }).click();
    await usage.getByRole('alert').filter({ hasText: 'Saved attempt failed: exact fixture cause' }).waitFor();
    // Usage details are directly accessible in the rail.
    await usage.getByRole('button', { name: 'Refresh', exact: true }).click();
    assert.match(await usage.innerText(), /Saved attempt failed: exact fixture cause/);
    assert.doesNotMatch(await usage.innerText(), /Resume requested|Saved work completed/);
    assert.equal(resumes.length, 5);
    fail = true; await usage.getByRole('button', { name: 'Refresh', exact: true }).click();
    await usage.getByRole('alert').filter({ hasText: 'Previously loaded values may be stale' }).waitFor();
    assert.match(await usage.innerText(), /Saved attempt failed: exact fixture cause/);
    // Completed Qwen work retains an estimate, rather than fabricated actuals.
    fail = false; proposals=[]; running=[{...pending('qwen'),provider:'runpod',model:'Qwen/Qwen3-VL-8B-Instruct',category:'attachment-observation',state:'dispatched',reservedMicrousd:'20000',pollableRunpod:true}];
    await usage.getByRole('button', {name:'Refresh',exact:true}).click();
    await active.getByRole('button',{name:'Check saved Qwen analysis',exact:true}).waitFor();
    assert.equal(await active.getByRole('button',{name:'Accept exposure & continue',exact:true}).count(),0);
    assert.match(await active.innerText(),/polls that existing job and will not submit another/);
    resumeMode='completed';
    await active.getByRole('button',{name:'Check saved Qwen analysis',exact:true}).click();
    await usage.getByRole('status').filter({hasText:'Saved work completed.'}).waitFor();
    await usage.getByText('RunPod estimated infrastructure cost $0.02 · actual cost unconfirmed',{exact:true}).first().waitFor();
    await usage.getByRole('button', { name: 'Show model usage for runpod' }).focus();
    await providerTooltip.waitFor();
    assert.match(await providerTooltip.innerText(), /Qwen\/Qwen3-VL-8B-Instruct/);
    assert.doesNotMatch(await providerTooltip.innerText(), /gpt-4o/);
    assert.equal(resumes.length,6,'checking saved Qwen work resumes once; no new approval decision');
    const imageStages=rail.getByRole('list',{name:'Image analysis stages',exact:true});
    await imageStages.getByText('Qwen image analysis complete',{exact:true}).waitFor();
    assert.match(await imageStages.innerText(),/Using saved Qwen observation/);
    assert.equal(await active.count(),0,'estimated completion is not pending or uncertain active work');
    const infraText=await usage.innerText();
    assert.match(infraText,/Spent\s+\$0\.27/);
    assert.match(infraText,/Includes estimated infrastructure cost; actual RunPod cost unconfirmed/);
    assert.match(infraText,/RunPod estimated infrastructure cost \$0\.02/);
    assert.doesNotMatch(infraText,/RunPod actual cost \$0.02/);
    await page.reload({waitUntil:'domcontentloaded'});
    await usage.getByText('RunPod estimated infrastructure cost $0.02 · actual cost unconfirmed',{exact:true}).first().waitFor();
    assert.equal(resumes.length,6,'estimated infrastructure reload cannot dispatch');
    // A deterministic unsupported blocker cannot offer another unchanged retry.
    running=[{...pending('technical'),state:'uncertain',exposureAccepted:true,continuationBlockedReason:'standalone_no_priceable_vision: No priceable vision model supports this image.'}];
    await usage.getByRole('button',{name:'Refresh',exact:true}).click();
    await active.getByRole('alert').filter({hasText:'No priceable vision model'}).waitFor();
    assert.equal(await active.getByRole('button',{name:/Continue remaining work|Accept exposure & continue|Resume saved work/}).count(),0);
    assert.equal(await active.getByRole('button',{name:'Cancel remaining work',exact:true}).count(),1);
    running=[{...pending('format'),state:'reserved',continuationBlockedReason:'standalone_unsupported_image: This image format is unsupported.'}];
    await usage.getByRole('button',{name:'Refresh',exact:true}).click();
    await active.getByRole('alert').filter({hasText:'image format is unsupported'}).waitFor();
    assert.equal(await active.getByRole('button',{name:'Resume saved work',exact:true}).count(),0);
    assert.equal(resumes.length,6,'technical blockers cannot trigger another resume');
    running=[]; proposals=[pending('qwen-approval',{provider:'runpod',model:'Qwen/Qwen3-VL-8B-Instruct',category:'attachment-observation',reservedMicrousd:'20000',pauseReason:'request_threshold',budgetRevision:configuration.budget_revision})];
    await usage.getByRole('button',{name:'Refresh',exact:true}).click();
    await usage.getByText('Fixed reservation: use fewer images in a new request to reduce cost.',{exact:true}).waitFor();
    assert.equal(await usage.getByRole('button',{name:'Reduce cost',exact:true}).count(),0,'fixed infrastructure policy cannot use token reduction');
    assert.equal(await usage.getByRole('button',{name:'Approve once',exact:true}).count(),1,'normal exact-attempt approval remains available for infrastructure threshold pause');
    assert.equal(resumes.length,6);
    // Completed parents retain unresolved exposure without operational controls.
    proposals=[];running=[{...pending('completed-qwen'),provider:'runpod',model:'Qwen/Qwen3-VL-8B-Instruct',state:'uncertain',reservedMicrousd:'20000',parentStatus:'completed',continuationActionable:false,cancellationActionable:false}];
    await usage.getByRole('button',{name:'Refresh',exact:true}).click();
    await active.getByText('Uncertain exposure retained · parent request already completed',{exact:true}).waitFor();
    assert.equal(await active.getByRole('button').count(),0);
    await page.screenshot({path:join(screenshots,'completed-qwen-alert-only.png'),fullPage:true});
    running=[{...running[0],parentStatus:'failed',continuationBlockedReason:'standalone_no_priceable_vision: independent technical blocker'}];
    await usage.getByRole('button',{name:'Refresh',exact:true}).click();
    await active.getByRole('alert').filter({hasText:'independent technical blocker'}).waitFor();
    assert.equal(await active.getByRole('button').count(),0);
    running=[{...pending('running'),state:'dispatched',parentStatus:'running',continuationActionable:false,cancellationActionable:true}];
    await usage.getByRole('button',{name:'Refresh',exact:true}).click();
    await active.getByRole('button',{name:'Cancel remaining work',exact:true}).waitFor();
    assert.equal(await active.getByRole('button').count(),1,'running non-uncertain work remains cancellable');
    // Durable policy authority resumes a paused original request without a button or decision.
    running=[{...pending('auto-qwen'),state:'uncertain',provider:'runpod',reservedMicrousd:'20000',uncertainAutoAuthorized:true,exposureAccepted:true,parentStatus:'paused',continuationActionable:false,cancellationActionable:false}];
    resumeMode='completed';
    const beforeAuto=resumes.length,beforeDecisions=decisions.length;
    await usage.getByRole('button',{name:'Refresh',exact:true}).click();
    await usage.getByRole('status').filter({hasText:'Automatically continued within owner spending limits.'}).waitFor();
    assert.equal(resumes.length,beforeAuto+1);assert.equal(decisions.length,beforeDecisions);
    assert.equal(await active.getByRole('button').count(),0);
    await usage.getByRole('button',{name:'Refresh',exact:true}).click();
    assert.equal(resumes.length,beforeAuto+1,'polling does not resume the same original request twice');
    running=[{...running[0],parentStatus:'completed'}];
    await page.reload({waitUntil:'domcontentloaded'});
    await active.getByText(/auto-authorized within owner limits/).waitFor();
    assert.equal(resumes.length,beforeAuto+1,'completed parent never resumes after refresh');
    running=[{...running[0],id:'auto-transient',requestId:'auto-transient',parentStatus:'paused'}];resumeMode='failed';
    await usage.getByRole('button',{name:'Refresh',exact:true}).click();
    await usage.getByRole('alert').filter({hasText:'Saved attempt failed: exact fixture cause'}).waitFor();
    assert.equal(resumes.length,beforeAuto+2);
    resumeMode='completed';await page.waitForTimeout(5100);
    const retryCompleted=page.waitForResponse(response=>response.url().endsWith('/api/chat'));
    await usage.getByRole('button',{name:'Refresh',exact:true}).click();
    await usage.getByRole('status').filter({hasText:'Automatically continued within owner spending limits.'}).waitFor();
    await retryCompleted;
    assert.equal(resumes.length,beforeAuto+3,'transient failure remains retryable through Refresh');
    assert.equal(decisions.length,beforeDecisions,'retry never asks for exposure acceptance');
    // Exact incident: an old failed JPEG receipt, followed by a plain text turn.
    running=[];resumeMode='completed';
    await page.evaluate(async id=>{
      await new Promise((resolve,reject)=>{
        const req=indexedDB.open('katie-pending-input-v1',1);
        req.onupgradeneeded=()=>req.result.createObjectStore('conversations');
        req.onerror=()=>reject(req.error);
        req.onsuccess=()=>{const db=req.result,tx=db.transaction('conversations','readwrite');
          tx.objectStore('conversations').put({images:[],imageFiles:[],videos:[],files:[],references:[{fileId:'previously-failed-jpeg',fileName:'failed.jpg',mimeType:'image/jpeg',attachmentKind:'image',preview:'',imageDataUrl:'data:image/jpeg;base64,QUJD'}]},id);
          tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);
        };
      });
    },chatId);
    for(let refresh=0;refresh<2;refresh++){
      await page.reload({waitUntil:'domcontentloaded'});
      await page.waitForFunction(async id=>{
        return new Promise(resolve=>{const req=indexedDB.open('katie-pending-input-v1',1);req.onsuccess=()=>{const db=req.result,get=db.transaction('conversations').objectStore('conversations').get(id);get.onsuccess=()=>{resolve(!get.result?.references?.length);db.close();};};});
      },chatId);
    }
    const composer=page.locator('main textarea').last();
    await composer.fill('Katie, that is an awesome start but i know you can do way better');
    const sent=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/chat');
    await composer.press('Enter');
    const followup=(await sent).postDataJSON();
    assert.equal(followup.images?.length??0,0);assert.equal(followup.fileReferences?.length??0,0);
    await page.waitForTimeout(500);
    // A slow refresh spans an interval plus focus/update storms. Transport stays single-flight.
    const beforeSlow=usageRequests;maxUsageInFlight=0;holdUsage=true;
    const slowStarted=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/standalone-accounting/usage');
    await usage.getByRole('button',{name:'Refresh',exact:true}).click();await slowStarted;
    await page.evaluate(()=>{for(let i=0;i<10;i++){window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('standalone-accounting-updated'));}});
    await page.waitForTimeout(15500);
    assert.equal(usageRequests,beforeSlow+1,'focus/update/timer must not overlap the slow HTTP request');
    const queued=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/standalone-accounting/usage');
    holdUsage=false;heldUsage.splice(0).forEach(resolve=>resolve());await queued;await page.waitForTimeout(250);
    assert.equal(usageRequests,beforeSlow+2,'one coalesced refresh follows the slow request');
    assert.equal(maxUsageInFlight,1,'real browser never has concurrent usage transports');
    const beforeHidden=usageRequests;
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForTimeout(15500);assert.equal(usageRequests,beforeHidden,'hidden document does not poll');
    const visibleRefresh=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/standalone-accounting/usage');
    await page.evaluate(()=>{delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));});await visibleRefresh;await page.waitForTimeout(250);
    // Scope replacement aborts the prior transport; old data cannot overwrite the new scope.
    holdUsage=true;
    const oldScope=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/standalone-accounting/usage');
    await usage.getByRole('button',{name:'Refresh',exact:true}).click();await oldScope;
    const newScope=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/standalone-accounting/usage'&&new URL(request.url()).searchParams.get('scope')==='all');
    await usage.getByLabel('Scope').selectOption('all');await newScope;
    holdUsage=false;heldUsage.splice(0).forEach(resolve=>resolve());
    await usage.getByText(/In 999/).first().waitFor();
    assert.equal(await usage.getByLabel('Scope').inputValue(),'all');
    pagedApprovals=true;proposals=Array.from({length:100},(_,i)=>pending('page-'+i));running=[];
    workPage={next:{before:'2026-10-28T10:00:00Z',beforeId:'44444444-4444-4444-8444-444444444444'}};
    await usage.getByRole('button',{name:'Refresh',exact:true}).click();
    await usage.getByRole('button',{name:'Older active work',exact:true}).click();
    await usage.getByText(/attempt-older-paused/).first().waitFor();
    assert.equal(await usage.getByRole('button',{name:'Newest work',exact:true}).count(),1,'all-paused pages retain navigation');
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
