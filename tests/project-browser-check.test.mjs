import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localRequestAllowed, runScenarios, checkProject } from '../scripts/project-browser-check.mjs';

test('acceptance executes actual browser interaction and fails a wrong rendered expectation', { timeout: 60000 }, async () => {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><button id="move" onclick="document.querySelector(\'#state\').textContent=\'Moved\'">Move</button><p id="state">Waiting</p>'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const contract = { path: '/', scenarios: [
      { name: 'Actual interaction', steps: [{ action: 'expectText', selector: '#state', value: 'Waiting' }, { action: 'click', selector: '#move' }, { action: 'expectText', selector: '#state', value: 'Moved' }] },
      { name: 'Deliberately wrong expectation', steps: [{ action: 'click', selector: '#move' }, { action: 'expectText', selector: '#state', value: 'Victory' }] },
    ] };
    const checks = await runScenarios(contract, origin, { timeout: 25000 });
    assert.equal(checks.length, 2); assert.equal(checks[0].passed, true); assert.equal(checks[1].passed, false);
    assert.match(checks[1].detail, /expected value/);
  } finally { await new Promise(done => server.close(done)); }
});
test('browser blocks external subresources and cross-origin redirects', { timeout: 30000 }, async () => {
  let escaped = 0;
  const external = createServer((_req, res) => { escaped++; res.end('external'); });
  await new Promise(done => external.listen(0, '127.0.0.1', done));
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:' + external.address().port }); res.end(); }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<div id="state">Ready</div><img src="http://127.0.0.1:' + external.address().port + '/resource">'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const checks = await runScenarios({ path: '/', scenarios: [{ name: 'Resource confinement', steps: [{ action: 'expectText', selector: '#state', value: 'Ready' }] }, { name: 'Redirect confinement', steps: [{ action: 'goto', path: '/redirect' }, { action: 'expectVisible', selector: '#state' }] }] }, origin, { timeout: 20000 });
    assert.equal(checks.every(c => !c.passed), true); assert.equal(escaped, 0);
  } finally { await Promise.all([new Promise(done => server.close(done)), new Promise(done => external.close(done))]); }
});
test('ordinary tasks emit no acceptance artifact and local request policy rejects host escapes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'katie-project-browser-'));
  try {
    const request = join(dir, 'request.md'), output = join(dir, 'result.json'); writeFileSync(request, 'Ordinary task'); writeFileSync(output, '{"passed":true}');
    assert.equal(await checkProject({ request, port: 3109, output }), null); assert.equal(existsSync(output), false);
    for (const url of ['https://production.test/api', 'http://127.0.0.1:3110/', 'http://user:pass@127.0.0.1:3109/', 'file:///tmp/file', 'data:text/html,yes', 'http://localhost:3109/']) assert.equal(localRequestAllowed(url, 'http://127.0.0.1:3109'), false, url);
    assert.equal(localRequestAllowed('http://127.0.0.1:3109/api/test', 'http://127.0.0.1:3109', 'POST'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
