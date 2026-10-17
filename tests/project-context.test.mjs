import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalJSON, contractHash, parseProjectContext, projectMarker, validateContract } from '../scripts/project-context.mjs';
const contract = () => ({ path: '/', scenarios: [{ name: 'Change game state', steps: [{ action: 'click', selector: '#move' }, { action: 'expectText', selector: '#state', value: 'Moved' }] }] });
const metadata = () => { const c = contract(); return { version: 1, projectId: randomUUID(), baseSha: 'a'.repeat(40), contractHash: contractHash(c), contract: c }; };
test('ordinary requests stay ordinary and exact marker round trips with stable canonical digest', () => {
  assert.equal(parseProjectContext('Build a game; baseSha: ' + 'b'.repeat(40)), null);
  const m = metadata(); assert.deepEqual(parseProjectContext('Objective\n' + projectMarker(m)), m);
  assert.equal(canonicalJSON({ z: [{ b: 2, a: 1 }], a: 3 }), '{"a":3,"z":[{"a":1,"b":2}]}');
  assert.equal(contractHash({ scenarios: m.contract.scenarios, path: '/' }), m.contractHash);
});
test('malformed, duplicate, oversized, forged and expanded project metadata fails closed', () => {
  const m = metadata(), marker = projectMarker(m);
  for (const text of [marker + marker, marker.replace(': ', ':'), marker.replace(' -->', '-->'), '<!-- katie-project: !!!! -->', '<!-- katie-project: ' + 'a'.repeat(42668) + ' -->']) assert.throws(() => parseProjectContext(text));
  const raw = value => '<!-- katie-project: ' + Buffer.from(JSON.stringify(value)).toString('base64url') + ' -->';
  for (const value of [{ ...m, baseSha: 'main' }, { ...m, contractHash: 'b'.repeat(64) }, { ...m, repository: 'attacker/repo' }, { ...m, contract: { ...m.contract, path: '//evil.test' } }]) assert.throws(() => parseProjectContext(raw(value)));
});
test('contracts reject external navigation, code, empty/trivial assertions and excessive steps', () => {
  for (const path of ['https://evil.test', '//evil.test', '/\\evil', '/%2fevil', '/%252fevil', '/a/../secret', '/%2e%2e/secret', '/%00', '/%2500', '/a\n', '/a#fragment', '/%ZZ']) assert.throws(() => validateContract({ ...contract(), path }), path);
  for (const steps of [[], [{ action: 'click', selector: '#move' }], [{ action: 'expectVisible', selector: 'body' }], [{ action: 'expectText', selector: '#state', value: '' }], [{ action: 'eval', value: 'true' }], [{ action: 'goto', path: '//evil' }], [{ action: 'expectText', selector: '#state', value: 'Moved', code: 'true' }], Array.from({ length: 101 }, () => ({ action: 'expectVisible', selector: '#state' }))]) assert.throws(() => validateContract({ path: '/', scenarios: [{ name: 'Bad', steps }] }));
});
test('prepare CLI returns JSON null for ordinary tasks and nonzero for malformed project tasks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'katie-project-context-'));
  try {
    const path = join(dir, 'AGENT_REQUEST.md'); writeFileSync(path, 'Ordinary task');
    let result = spawnSync(process.execPath, ['scripts/project-context.mjs', 'prepare', path], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
    assert.ifError(result.error); assert.equal(result.status, 0); assert.equal(result.stdout.trim(), 'null');
    writeFileSync(path, '<!-- katie-project: invalid -->');
    result = spawnSync(process.execPath, ['scripts/project-context.mjs', 'prepare', path], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } }); assert.ifError(result.error); assert.equal(result.status, 1); assert.equal(result.stdout, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
