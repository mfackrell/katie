import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import {runScenarios,prepareTrustedChromium} from './project-browser-engine.mjs';
export {localRequestAllowed,runScenarios} from './project-browser-engine.mjs';
import {sandboxArgs} from './project-sandbox.mjs';
import { parseProjectContext } from './project-context.mjs';

const TOTAL_MS = 150_000;
async function assertPortFree(port) {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  await new Promise(done => server.close(done));
}
export async function runIsolatedProjectCheck({ request, port, output, dependencies, browserExecutablePath }) {
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
    server = spawn('bwrap', [...sandboxArgs(process.cwd(),{dependencies,network:true}), '--setenv','NODE_ENV','production','--setenv','NEXT_TELEMETRY_DISABLED','1','--setenv','OPENAI_API_KEY',env.OPENAI_API_KEY,'--setenv','SUPABASE_SERVICE_ROLE_KEY',env.SUPABASE_SERVICE_ROLE_KEY,'--setenv','NEXT_PUBLIC_SUPABASE_URL',env.NEXT_PUBLIC_SUPABASE_URL,'--setenv','NEXT_PUBLIC_SUPABASE_ANON_KEY',env.NEXT_PUBLIC_SUPABASE_ANON_KEY,process.execPath,'/app/node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env,stdio:['ignore','pipe','pipe'],detached:false});
    server.on('error', error => { logs = String(error.message).slice(0, 2000); });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
    const kill = () => { try { server.kill('SIGKILL'); } catch {} };
    timer = setTimeout(() => { expired = true; kill(); }, TOTAL_MS);
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    while (Date.now() - started < 30_000 && server.exitCode === null) {
      try { const response = await fetch(origin + metadata.contract.path, { signal: AbortSignal.timeout(1500), redirect: 'manual' }); await response.body?.cancel(); if (/Ready in/u.test(logs) && server.exitCode === null) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    if (!ready) throw Error('Local Next application did not start (exit=' + server.exitCode + ', signal=' + server.signalCode + '): ' + logs.slice(-450));
    // The browser bundle and Open Sans font tree were expanded by the trusted
    // verifier before entering the user namespace. Sparticuz calls chown()
    // while expanding /tmp/fonts, which fails under UID-mapped namespaces.
    // The already prepared binary is read-only to generated app code.
    if (typeof browserExecutablePath !== 'string' || !browserExecutablePath.startsWith('/tmp/') || !existsSync(browserExecutablePath))
      throw Error('Trusted Chromium executable was not prepared before namespace entry');
    report.checks = await runScenarios(metadata.contract, origin, { executablePath: browserExecutablePath, timeout: TOTAL_MS - (Date.now() - started) - 5000 });
    const finalHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
    report.passed = !expired && finalHead === headSha && server.exitCode === null && report.checks.length === metadata.contract.scenarios.length && report.checks.every(c => c.passed);
  } catch (error) { report.checks.push({ name: 'browser runner', passed: false, detail: String(error.message).slice(0, 600) }); }
  finally {
    clearTimeout(timer);
    if (server?.pid) { try { server.kill('SIGKILL'); } catch {} await new Promise(done => { if (server.exitCode !== null || server.signalCode) done(); else server.once('exit', done); }); }
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}
// A fresh Linux network namespace has only loopback and no route to any host
// network (including host localhost). Never fall back to unsandboxed execution.
export const networkBootstrap = `import os, socket, fcntl, struct, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
fcntl.ioctl(s, 0x8914, struct.pack("16sH14s", b"lo", 0x49, b""))
s.close()
os.execv(sys.argv[1], sys.argv[1:])
`;
// PID numbers must resolve in the same procfs view before nested Bubblewrap
// opens /proc/<pid>/ns. --mount-proc creates a private mount namespace too.
export const projectNetworkNamespaceArgs = Object.freeze(['--user', '--map-root-user', '--net', '--pid', '--fork', '--mount-proc', '--kill-child=SIGKILL']);
export async function checkProject({ request, port, output, dependencies }) {
  if (resolve(request) === resolve(output)) throw Error('Acceptance output must not overwrite the original request');
  const metadata = parseProjectContext(readFileSync(request, 'utf8'));
  rmSync(output, { force: true });
  if (!metadata) return null;
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
  const report = { version: 1, projectId: metadata.projectId, contractHash: metadata.contractHash, headSha, passed: false, checks: [] };
  let child, timer, logs = '';
  try {
    // Provision fonts and the Chromium executable in the trusted runner
    // BEFORE entering an unprivileged user namespace. No model-authored
    // application code executes during provisioning.
    const browserExecutablePath = await prepareTrustedChromium();
    const moduleUrl = import.meta.url;
    const code = `import { runIsolatedProjectCheck } from ${JSON.stringify(moduleUrl)}; const r = await runIsolatedProjectCheck(JSON.parse(process.argv[1])); if (!r.passed) process.exitCode = 1;`;
    child = spawn('unshare', [...projectNetworkNamespaceArgs, 'python3', '-c', networkBootstrap,
      process.execPath, '--input-type=module', '-e', code, JSON.stringify({ request: resolve(request), port, output: resolve(output), dependencies, browserExecutablePath })], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: '/tmp', TMPDIR: '/tmp', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
    });
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    timer = setTimeout(kill, TOTAL_MS + 10_000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk.toString()).slice(-2000); });
    const status = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
    if (status !== 0 || !existsSync(output)) throw Error('Isolated acceptance failed: ' + logs);
    return JSON.parse(readFileSync(output, 'utf8'));
  } catch (error) {
    // Preserve actual failed assertions when the isolated runner reached them.
    if (existsSync(output)) {
      const result = JSON.parse(readFileSync(output, 'utf8'));
      if (result.passed === false) return result;
    }
    report.checks.push({ name: 'network isolation', passed: false, detail: String(error.message).slice(0, 600) });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    clearTimeout(timer);
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== '--request' || args[2] !== '--port' || args[4] !== '--output') throw Error('Usage: project-browser-check.mjs --request ORIGINAL_AGENT_REQUEST.md --port 3109 --output project-acceptance.json');
    const report = await checkProject({ request: args[1], port: Number(args[3]), output: args[5] });
    if (report && !report.passed) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
