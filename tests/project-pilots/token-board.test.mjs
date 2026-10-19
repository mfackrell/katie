import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import ts from 'typescript';
import { chromium } from 'playwright-core';
import bundledChromium from '@sparticuz/chromium';
import { runScenarios } from '../../scripts/project-browser-engine.mjs';

const path = '/project-pilots/token-board';
const text = (selector, value) => ({ action: 'expectText', selector, value: String(value) });
const click = cell => ({ action: 'click', selector: `#cell-${cell}` });
const contract = {
  path,
  scenarios: [
    {
      name: 'Initial board and numeric counters',
      steps: [
        { action: 'goto', path },
        ...Array.from({ length: 9 }, (_, cell) => ({ action: 'expectVisible', selector: `#cell-${cell}` })),
        { action: 'expectVisible', selector: '#position' },
        { action: 'expectVisible', selector: '#moves' },
        { action: 'expectVisible', selector: '#reset' },
        text('#position', 0), text('#moves', 0),
      ],
    },
    {
      name: 'Legal move, rejected diagonal, same-route persistence and reset',
      steps: [{ action: 'goto', path }, click(1), text('#position', 1), text('#moves', 1),
        click(5), text('#position', 1), text('#moves', 1),
        { action: 'goto', path }, text('#position', 1), text('#moves', 1),
        { action: 'click', selector: '#reset' }, text('#position', 0), text('#moves', 0),
        { action: 'goto', path }, text('#position', 0), text('#moves', 0)],
    },
  ],
};

// Default to the actual page component with real React and Chromium, following
// the repository's browser-test pattern. Set TOKEN_BOARD_TEST_ORIGIN to also
// exercise the built Next route, shared layout, styles, and hydration.
test('token board browser contract and every source/destination movement pair', { timeout: 120_000 }, async () => {
  let server;
  let browser;
  try {
    let origin = process.env.TOKEN_BOARD_TEST_ORIGIN;
    if (!origin) {
      const code = ts.transpileModule(readFileSync('app/project-pilots/token-board/page.tsx', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
      }).outputText;
      const react = readFileSync('node_modules/react/umd/react.production.min.js', 'utf8');
      const reactDom = readFileSync('node_modules/react-dom/umd/react-dom.production.min.js', 'utf8');
      const boardCode = ts.transpileModule(readFileSync('app/project-pilots/token-board/board.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const html = `<!doctype html><html><body><div id="root"></div><script>${react}\n${reactDom}</script>
        <script>const exports = {}, boardExports = {}; (function(exports) { ${boardCode} })(boardExports);
        const require = name => { if (name === 'react') return React; if (name === './board') return boardExports; throw Error(name); };
        ${code}
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(exports.default));</script></body></html>`;
      server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${server.address().port}`;
    }
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const executablePath = await bundledChromium.executablePath();
    const checks = await runScenarios(contract, origin, { executablePath, timeout: 60_000 });
    assert.equal(checks.length, contract.scenarios.length);
    assert.ok(checks.every(check => check.passed), JSON.stringify(checks));

    browser = await chromium.launch({ executablePath, args: bundledChromium.args.filter(arg => arg !== '--single-process'), headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // A legal traversal reaches every cell, including row edges. Checking all
    // 81 pairs catches diagonal moves, row wrapping, long jumps and self-clicks.
    const traversal = [0, 1, 2, 5, 4, 3, 6, 7, 8];
    for (let source = 0; source < 9; source++) {
      for (let destination = 0; destination < 9; destination++) {
        await page.goto(origin + path);
        await page.locator('#reset').click();
        const index = traversal.indexOf(source);
        for (const cell of traversal.slice(1, index + 1)) await page.locator(`#cell-${cell}`).click();
        await page.locator(`#cell-${destination}`).click();
        const legal = Math.abs(Math.floor(source / 3) - Math.floor(destination / 3)) + Math.abs(source % 3 - destination % 3) === 1;
        const expectedPosition = legal ? destination : source;
        await page.waitForFunction(({ position, moves }) => document.querySelector('#position')?.textContent === String(position) && document.querySelector('#moves')?.textContent === String(moves), { position: expectedPosition, moves: index + Number(legal) });
        assert.equal(await page.locator('[aria-pressed="true"]').count(), 1);
        assert.equal(await page.locator(`#cell-${expectedPosition}`).getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator(`#cell-${expectedPosition} > span`).count(), 1);
      }
    }
    // Native buttons must support keyboard movement as well as pointer clicks.
    await page.goto(origin + path);
    await page.locator('#reset').click();
    await page.locator('#cell-3').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#position')?.textContent === '3');
    assert.equal(await page.locator('#moves').textContent(), '1');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
});
