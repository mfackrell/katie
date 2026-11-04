import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync('app/project-pilots/take-eleven/engine.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const context = { exports: {}, Object, Number };
runInNewContext(compiled, context, { timeout: 3000 });
const { initialState, transition } = context.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const state0 = () => plain(initialState);
const take = (state, count) => plain(transition(state, { type: 'TAKE', count }));

test('exact initial state and INIT no-op', () => {
  assert.deepEqual(state0(), { stones: 11, activePlayer: 'A', phase: 'IN_PROGRESS', winner: null });
  const state = state0();
  assert.equal(transition(state, { type: 'INIT' }), state);
});

test('legal takes of 1, 2 and 3 subtract and alternate players', () => {
  for (const count of [1, 2, 3]) {
    assert.deepEqual(take(state0(), count), {
      stones: 11 - count, activePlayer: 'B', phase: 'IN_PROGRESS', winner: null,
    });
  }
});

test('illegal moves, non-integers and unknown actions preserve original object', () => {
  const original = state0();
  const before = JSON.stringify(original);
  for (const action of [
    { type: 'TAKE', count: 0 },
    { type: 'TAKE', count: 4 },
    { type: 'TAKE', count: -1 },
    { type: 'TAKE', count: 2.5 },
    { type: 'TAKE', count: NaN },
    { type: 'TAKE', count: '1' },
    { type: 'BOGUS' },
  ]) assert.equal(transition(original, action), original);
  assert.equal(JSON.stringify(original), before);
  const one = { stones: 1, activePlayer: 'B', phase: 'IN_PROGRESS', winner: null };
  assert.equal(transition(one, { type: 'TAKE', count: 2 }), one);
});

test('legal turns alternate correctly through the game', () => {
  let current = state0();
  for (const [count, stones, player] of [[3, 8, 'B'], [2, 6, 'A'], [3, 3, 'B']]) {
    current = take(current, count);
    assert.deepEqual([current.stones, current.activePlayer], [stones, player]);
  }
});

test('either A or B can win by taking the final stone', () => {
  for (const [moves, winner] of [[[3, 3, 3, 2], 'B'], [[3, 3, 3, 1, 1], 'A']]) {
    let current = state0();
    for (const count of moves) current = take(current, count);
    assert.deepEqual(current, { stones: 0, activePlayer: winner, phase: 'FINISHED', winner });
    assert.equal(transition(current, { type: 'TAKE', count: 1 }), current);
  }
});

test('reset restores exact initial state, including from terminal state', () => {
  let current = state0();
  for (const n of [3, 3, 3, 2]) current = take(current, n);
  assert.deepEqual(plain(transition(current, { type: 'RESET' })), state0());
  assert.deepEqual(plain(transition(take(state0(), 2), { type: 'RESET' })), state0());
});

test('transition is deterministic and never mutates input', () => {
  const before = state0();
  const frozen = Object.freeze({ ...before });
  const one = take(frozen, 3), two = take(frozen, 3);
  assert.deepEqual(one, two);
  assert.deepEqual(before, state0());
  assert.deepEqual(frozen, before);
});

test('UI binds the pure engine, persistence and the source-bound selectors', () => {
  const page = readFileSync('app/project-pilots/take-eleven/page.tsx', 'utf8');
  assert.match(page, /import \{ initialState, transition/);
  assert.match(page, /localStorage\.getItem\(STORAGE_KEY\)/);
  assert.match(page, /localStorage\.setItem\(STORAGE_KEY, JSON\.stringify\(game\)\)/);
  assert.match(page, /if \(!loaded\) return/);
  for (const id of ['stone-count', 'active-player', 'phase', 'winner']) assert.ok(page.includes('data-testid="'+id+'"'));
  assert.match(page, /aria-label="Reset"/);
  assert.match(page, /aria-label=\{\`Take \$\{count\}\`\}/);
});

test('the full frozen Take Eleven browser contract runs against the real Next route', { timeout: 145000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:net');
  const { once } = await import('node:events');
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { chromium } = await import('playwright-core');
  const { default: bundledChromium } = await import('@sparticuz/chromium');

  const root = resolve('.');
  // Compile the unchanged real game route in a minimal, disposable Next app.
  // Loading Katie's entire workspace development server here took longer than
  // the global test-runner deadline and concealed the actual browser results.
  const fixture = await mkdtemp(join(tmpdir(), 'take-eleven-browser-'));
  const request = readFileSync('tests/fixtures/take-eleven-frozen-development-request.md', 'utf8');
  const marker = request.match(/<!-- katie-project: ([A-Za-z0-9_-]+) -->/);
  assert.ok(marker, 'Frozen Take Eleven contract is present');
  const project = JSON.parse(Buffer.from(marker[1], 'base64url').toString('utf8'));
  const scenarios = project.contract.scenarios;
  assert.equal(scenarios.length, 5, 'All five approved browser scenarios must execute');

  let server, browser, output = '';
  try {
    const routeDir = join(fixture, 'app/project-pilots/take-eleven');
    await mkdir(routeDir, { recursive: true });
    await symlink(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
    await writeFile(join(fixture, 'package.json'), '{"name":"take-eleven-browser-fixture","private":true}');
    await writeFile(join(fixture, 'next.config.mjs'), 'export default { reactStrictMode: true };');
    await writeFile(join(fixture, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', lib: ['dom', 'dom.iterable', 'esnext'],
        strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true,
        module: 'esnext', moduleResolution: 'bundler', jsx: 'preserve' },
      include: ['**/*.ts', '**/*.tsx'],
    }));
    await writeFile(join(fixture, 'app/layout.tsx'),
      'export default function Layout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>;}');
    // The page and engine bytes are copied verbatim from the submitted source.
    for (const file of ['page.tsx', 'engine.ts']) {
      await writeFile(join(routeDir, file),
        readFileSync(join(root, 'app/project-pilots/take-eleven', file), 'utf8'));
    }

    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const origin = 'http://127.0.0.1:' + port;

    server = spawn(process.execPath,
      [join(root, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
      { cwd: fixture, env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '/tmp',
        NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', bytes => {
      output = (output + String(bytes)).slice(-12000);
    });
    const deadline = Date.now() + 45000;
    while (!output.includes('Ready in')) {
      if (server.exitCode !== null || Date.now() > deadline)
        throw Error('Disposable Take Eleven Next server failed to start: ' + output);
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    browser = await chromium.launch({
      executablePath: process.env.KATIE_TEST_CHROMIUM || await bundledChromium.executablePath(),
      args: bundledChromium.args, headless: true,
    });
    for (const scenario of scenarios) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        for (const [index, step] of scenario.steps.entries()) {
          const prefix = scenario.name + ' step ' + (index + 1) + ' (' + step.action + ')';
          switch (step.action) {
            case 'goto':
              assert.equal(step.path, '/project-pilots/take-eleven', prefix + ' approved route');
              await page.goto(origin + step.path, { waitUntil: 'domcontentloaded', timeout: 20000 });
              await page.locator('main[data-game-ready="true"]').waitFor({ state: 'visible', timeout: 10000 });
              break;
            case 'click':
              await page.locator(step.selector).click({ timeout: 7000 });
              break;
            case 'expectVisible':
              await page.locator(step.selector).waitFor({ state: 'visible', timeout: 7000 });
              break;
            case 'expectText':
              await page.waitForFunction(
                ({selector, value}) => document.querySelector(selector)?.textContent?.trim() === value,
                { selector: step.selector, value: step.value }, { timeout: 8000 });
              break;
            default:
              assert.fail(prefix + ' unsupported action');
          }
        }
        assert.deepEqual(errors, [], scenario.name + ' browser errors');
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    if (server && server.exitCode === null) server.kill('SIGTERM');
    await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
