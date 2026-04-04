#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const buildIdPath = '.next/BUILD_ID';
const port = process.env.SMOKE_PORT ?? '3100';

if (!existsSync(buildIdPath)) {
  console.error(`Missing ${buildIdPath}. Run npm run build before smoke test.`);
  process.exit(1);
}

const child = spawn(
  'node',
  ['--disable-warning=DEP0169', './node_modules/next/dist/bin/next', 'start', '-p', port],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' }
  }
);

let settled = false;
let ready = false;

const cleanup = (exitCode) => {
  if (settled) return;
  settled = true;
  if (!child.killed) {
    child.kill('SIGTERM');
  }
  process.exit(exitCode);
};

child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (text.toLowerCase().includes('ready')) {
    ready = true;
  }
});

child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk.toString());
});

child.on('exit', (code) => {
  if (!settled) {
    console.error(`next start exited before smoke test completed (code ${code ?? 'unknown'}).`);
    cleanup(1);
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const probe = async () => {
  const url = `http://127.0.0.1:${port}/`;

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    if (settled) return;
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) {
        console.log(`Smoke check passed with status ${response.status} at ${url}.`);
        cleanup(0);
        return;
      }
    } catch {
      // retry while server starts
    }
    await sleep(1000);
  }

  console.error(`Smoke check failed: no healthy response from ${url}. ready=${ready}`);
  cleanup(1);
};

probe();
