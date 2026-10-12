import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertComplete, runNodeFile } from "../scripts/run-tests.mjs";

function fixture(source, options) {
  const dir = mkdtempSync(join(tmpdir(), "katie-runner-fixture-"));
  const file = join(dir, "fixture.mjs");
  writeFileSync(file, `import test from 'node:test';\nimport assert from 'node:assert/strict';\n${source}\n`);
  try { return runNodeFile(file, join(dir, "report.json"), options); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("test gate accepts completed tests and reports their exact count", () => {
  assert.equal(fixture("test('first', () => {}); test('second', () => {});").tests, 2);
});

test("test gate rejects assertion failures", () => {
  assert.throws(() => fixture("test('failure', () => assert.equal(1, 2));"), /Test process failed/);
});

test("test gate rejects files that register no tests", () => {
  assert.throws(() => fixture("console.log('loaded without tests');"), /Incomplete or failed/);
});

test("test gate rejects skipped and todo tests", () => {
  assert.throws(() => fixture("test.skip('skipped', () => {});"), /Incomplete or failed/);
  assert.throws(() => fixture("test.todo('unfinished');"), /Incomplete or failed/);
});

test("test gate rejects a successful early exit before and during tests", () => {
  assert.throws(() => fixture("process.exit(0);"), /Incomplete or failed/);
  assert.throws(() => fixture("test('first', () => {}); test('unfinished', () => process.exit(0));"), /Incomplete or failed/);
});

test("test gate rejects cancelled tests and killed processes", () => {
  assert.throws(() => fixture("test('never resolves', () => new Promise(() => {}));"), /Test process failed/);
  assert.throws(() => fixture("process.kill(process.pid, 'SIGTERM');"), /Test process failed/);
});

test("test gate rejects a process that times out", () => {
  assert.throws(() => fixture("test('hang', () => new Promise(() => {})); setInterval(() => {}, 1000);", {
    timeout: 1000,
  }), /Test process failed/);
});

test("completion validation rejects absent, partial and cancelled reports", () => {
  const complete = { success: true, completed: 2, counts: {
    tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0,
  } };
  assert.doesNotThrow(() => assertComplete(complete));
  assert.throws(() => assertComplete(null), /Incomplete or failed/);
  assert.throws(() => assertComplete({ ...complete, completed: 1 }), /Incomplete or failed/);
  assert.throws(() => assertComplete({ ...complete, counts: { ...complete.counts, cancelled: 1 } }), /Incomplete or failed/);
});
