import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localRequestAllowed, runScenarios, checkProject, networkBootstrap, projectNetworkNamespaceArgs } from '../scripts/project-browser-check.mjs';
import { prepareTrustedChromium } from '../scripts/project-browser-engine.mjs';

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

test('isolated application route cannot contact a host-network service', { timeout: 15000 }, async () => {
  let escaped = 0;
  const external = createServer((_req, res) => { escaped++; res.end('host service'); });
  await new Promise(done => external.listen(0, '127.0.0.1', done));
  let child;
  try {
    const target = 'http://127.0.0.1:' + external.address().port;
    // This is real server-side application I/O, beyond browser interception.
    const code = `
      import { createServer } from 'node:http';
      import assert from 'node:assert/strict';
      import {readlinkSync} from 'node:fs';
      import {execFileSync} from 'node:child_process';
      import {sandboxArgs} from ${JSON.stringify(new URL('../scripts/project-sandbox.mjs', import.meta.url).href)};
      assert.equal(readlinkSync('/proc/self'), String(process.pid), 'procfs must describe the active PID namespace');
      // Reproduce the actual browser runner's nested sandbox startup, not just
      // a network-only child. The old host procfs view fails the PID invariant.
      for(let i=0;i<3;i++)execFileSync('bwrap',[...sandboxArgs(process.cwd(),{network:true}),'/bin/true'],{stdio:'pipe'});
      const server = createServer(async (_req, res) => {
        try {
          await fetch(${JSON.stringify(target)}, { signal: AbortSignal.timeout(1000) });
          res.end('ESCAPED');
        } catch { res.end('BLOCKED'); }
      });
      do {
        if (server.listening) await new Promise(done => server.close(done));
        await new Promise(done => server.listen(0, '127.0.0.1', done));
      } while (server.address().port === ${external.address().port});
      const response = await fetch('http://127.0.0.1:' + server.address().port);
      console.log(await response.text());
      await new Promise(done => server.close(done));
    `;
    child = spawn('unshare', [...projectNetworkNamespaceArgs, 'python3', '-c', networkBootstrap,
      process.execPath, '--input-type=module', '-e', code], {
      env: { PATH: process.env.PATH, HOME: '/tmp' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const status = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
    assert.equal(status, 0, stderr);
    assert.equal(stdout.trim(), 'BLOCKED');
    assert.equal(escaped, 0);
  } finally {
    child?.kill('SIGKILL');
    await new Promise(done => external.close(done));
  }
});

test('only the exact injected Vercel toolbar script is excluded from deployed application failures, and is still aborted',async()=>{
 const {platformToolbar}=await import('../scripts/project-browser-engine.mjs');const url='https://vercel.live/_next-live/feedback/feedback.js';assert.equal(platformToolbar(url,'script',true),true);for(const [u,t,d] of [[url,'script',false],[url,'fetch',true],['https://evil.test/_next-live/feedback/feedback.js','script',true],['https://vercel.live/other.js','script',true]])assert.equal(platformToolbar(u,t,d),false);
});

test('browser contexts isolate scenario storage while preserving reload state within each scenario',{timeout:30000},async()=>{const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><button id="move">Move</button><p id="state"></p><script>let n=Number(localStorage.getItem("moves")||0);const state=document.querySelector("#state");state.textContent=String(n);document.querySelector("#move").onclick=()=>{n++;localStorage.setItem("moves",String(n));state.textContent=String(n)};</script>');});await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;try{const checks=await runScenarios({path:'/',scenarios:[{name:'Reload retains this scenario state',steps:[{action:'expectText',selector:'#state',value:'0'},{action:'click',selector:'#move'},{action:'goto',path:'/'},{action:'expectText',selector:'#state',value:'1'}]},{name:'The next scenario starts with independent storage',steps:[{action:'expectText',selector:'#state',value:'0'},{action:'click',selector:'#move'},{action:'expectText',selector:'#state',value:'1'}]}]},origin,{timeout:20000,...(existsSync('/tmp/chromium')?{executablePath:'/tmp/chromium'}:{})});assert.equal(checks.length,2);assert.equal(checks.every(c=>c.passed),true,JSON.stringify(checks));}finally{await new Promise(done=>server.close(done));}});

test('Chromium font provisioning happens before UID-mapped acceptance browser subprocess', {timeout:75000}, async()=>{
  const executablePath = await prepareTrustedChromium();
  assert.equal(executablePath,'/tmp/chromium');
  // Test the same boundary used by project-browser-check: an already
  // extracted executable enters an unprivileged user/network namespace.
  // The runner cannot chown /tmp/fonts inside this namespace.
  const engineUrl = new URL('../scripts/project-browser-engine.mjs',import.meta.url).href;
  const code = `
    import {createServer} from 'node:http';
    import {runScenarios} from ${JSON.stringify(engineUrl)};
    const path=process.argv[1];
    const server=createServer((_req,res)=>{
      res.setHeader('Content-Type','text/html');
      res.end('<button id="move">Move</button><p id="position">0</p><script>document.getElementById("move").onclick=()=>document.getElementById("position").textContent="1"</script>');
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
      const origin='http://127.0.0.1:'+server.address().port;
      const checks=await runScenarios({path:'/',scenarios:[{name:'real browser movement',steps:[
        {action:'expectText',selector:'#position',value:'0'},
        {action:'click',selector:'#move'},
        {action:'expectText',selector:'#position',value:'1'}
      ]}]},origin,{executablePath:path,timeout:25000});
      if(!checks.length||checks.some(c=>!c.passed)){console.error(JSON.stringify(checks));process.exitCode=1;}
      else console.log('isolated pre-provisioned browser passed');
    }finally{await new Promise(resolve=>server.close(resolve));}
  `;
  const child=spawn('unshare',[...projectNetworkNamespaceArgs,
    'python3','-c',networkBootstrap,process.execPath,'--input-type=module','-e',code,executablePath],{
    env:{PATH:process.env.PATH,HOME:'/tmp',TMPDIR:'/tmp'},stdio:['ignore','pipe','pipe']
  });
  let stdout='',stderr='';
  child.stdout.on('data',b=>{stdout+=b.toString();});
  child.stderr.on('data',b=>{stderr+=b.toString();});
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  if(exit!==0&&!process.env.CI&&/Operation not permitted|No permissions|namespace/.test(stderr))return;
  assert.equal(exit,0,stderr);
  assert.match(stdout,/isolated pre-provisioned browser passed/);
});
