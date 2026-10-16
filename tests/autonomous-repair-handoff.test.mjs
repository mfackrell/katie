import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// js-yaml is already installed by the locked ESLint toolchain.
const { load } = createRequire(import.meta.url)('js-yaml');
const workflow = load(readFileSync(new URL('../.github/workflows/autonomous-development.yml', import.meta.url), 'utf8'));
const step = (job, name) => {
  const found = workflow.jobs[job].steps.find(s => s.name === name);
  assert.ok(found, `Missing ${job} step: ${name}`);
  return found;
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'katie-repair-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tests'));
  mkdirSync(join(root, 'temp', 'agent-task'), { recursive: true });
  const task = '[agent] Exact source repair\n\nOnly change authorized source.\nDo not add smoke tests.\nLiteral: $(touch injected) `touch injected`\n';
  writeFileSync(join(root, 'temp', 'agent-task', 'AGENT_REQUEST.md'), task);
  return { root, task };
}
function shell(script, root, mode, extra = {}) {
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, RUNNER_TEMP: join(root, 'temp'), REPAIR_SMOKE: mode, ...extra },
  });
}

test('the owner-validated task is preserved before the implementation agent runs', t => {
  const { root, task } = fixture(t);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'original-task'), task);
  writeFileSync(join(root, 'bin', 'gh'), '#!/bin/bash\nif [[ "$*" == *".author.login"* ]]; then echo owner; else cat original-task; fi\n', { mode: 0o755 });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const taskStep = step('build', 'Create isolated branch and task');
  const result = shell(taskStep.run, root, 'false', {
    PATH: `${join(root, 'bin')}:${process.env.PATH}`, GITHUB_OUTPUT: join(root, 'outputs'),
    GITHUB_REPOSITORY_OWNER: 'owner', GITHUB_REPOSITORY: 'owner/repo', ISSUE: '23',
    GITHUB_RUN_ID: '55', GITHUB_RUN_ATTEMPT: '1',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, 'temp', 'agent-task', 'AGENT_REQUEST.md'), 'utf8'), task);
  writeFileSync(join(root, 'AGENT_REQUEST.md'), 'developer changed local input');
  assert.equal(readFileSync(join(root, 'temp', 'agent-task', 'AGENT_REQUEST.md'), 'utf8'), task);
  assert.match(readFileSync(join(root, 'outputs'), 'utf8'), /repair_smoke=false/);
  const steps = workflow.jobs.build.steps;
  assert.ok(steps.indexOf(step('build', 'Preserve original task before implementation')) < steps.indexOf(step('build', 'Autonomous developer')));
});

test('non-owner task cannot produce the preserved snapshot', t => {
  const { root } = fixture(t);
  rmSync(join(root, 'temp', 'agent-task', 'AGENT_REQUEST.md'));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'gh'), '#!/bin/bash\necho intruder\n', { mode: 0o755 });
  const result = shell(step('build', 'Create isolated branch and task').run, root, 'true', {
    PATH: `${join(root, 'bin')}:${process.env.PATH}`, GITHUB_REPOSITORY_OWNER: 'owner',
    GITHUB_REPOSITORY: 'owner/repo', ISSUE: '23',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Only owner-authored/);
  assert.throws(() => readFileSync(join(root, 'temp', 'agent-task', 'AGENT_REQUEST.md')));
});

test('repair and both reviewers consume the same run-scoped task artifact', () => {
  const upload = step('build', 'Preserve original task before implementation');
  assert.equal(upload.with.name, 'agent-task');
  assert.equal(upload.with['if-no-files-found'], 'error');
  for (const job of ['repair', 'review', 'final-review']) {
    const download = workflow.jobs[job].steps.find(s => s.uses === 'actions/download-artifact@v4' && s.with.name === 'agent-task');
    assert.ok(download, `${job} must load the original task`);
    assert.ok(!workflow.jobs[job].steps.some(s => s.run?.includes('gh issue view')));
  }
  assert.match(step('repair', 'Independent repair agent').with.prompt, /AGENT_REQUEST.md and AGENT_REPAIR_CONTEXT.md/);
});

test('fault injection and repair use the same explicit issue-event mode', () => {
  const task = step('build', 'Create isolated branch and task');
  assert.equal(task.env.REPAIR_SMOKE, "${{ github.event_name == 'issues' && contains(github.event.issue.title, '[repair-smoke]') }}");
  assert.equal(step('build', 'Controlled failing regression for repair-pipeline smoke test').if, "${{ steps.task.outputs.repair_smoke == 'true' }}");
  assert.equal(workflow.jobs.build.outputs.repair_smoke, '${{ steps.task.outputs.repair_smoke }}');
  assert.equal(step('repair', 'Prepare task-specific repair instructions').env.REPAIR_SMOKE, '${{ needs.build.outputs.repair_smoke }}');
});

for (const mode of ['false', 'true']) {
  test(`actual repair preparation preserves the original task for mode ${mode}`, t => {
    const { root, task } = fixture(t);
    const result = shell(step('repair', 'Prepare task-specific repair instructions').run, root, mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, 'AGENT_REQUEST.md'), 'utf8'), task);
    const instructions = readFileSync(join(root, 'AGENT_REPAIR_CONTEXT.md'), 'utf8');
    if (mode === 'true') {
      assert.match(instructions, /Retain that regression/);
      assert.match(instructions, /private: true/);
    } else {
      assert.match(instructions, /Do not create or reintroduce/);
      assert.doesNotMatch(instructions, /Retain that regression|private: true/);
    }
    assert.throws(() => readFileSync(join(root, 'injected')));
  });
}

test('repair preparation fails without the original task instead of proceeding from findings alone', t => {
  const { root } = fixture(t);
  rmSync(join(root, 'temp', 'agent-task', 'AGENT_REQUEST.md'));
  assert.notEqual(shell(step('repair', 'Prepare task-specific repair instructions').run, root, 'false').status, 0);
});

test('missing and malformed repair modes fail closed', t => {
  const { root } = fixture(t);
  for (const mode of ['', 'TRUE', 'false\ntrue', 'unknown']) {
    assert.notEqual(shell(step('repair', 'Prepare task-specific repair instructions').run, root, mode).status, 0);
    for (const job of ['build', 'repair']) {
      assert.notEqual(shell(step(job, 'Reject smoke artifacts in ordinary tasks').run, root, mode).status, 0);
    }
  }
});

for (const job of ['build', 'repair']) {
  test(`${job} publishing guard rejects smoke contamination, including dangling symlinks`, t => {
    const { root } = fixture(t);
    const guard = step(job, 'Reject smoke artifacts in ordinary tasks');
    assert.equal(shell(guard.run, root, 'false').status, 0);
    const smoke = join(root, 'tests', 'agent-repair-smoke.test.mjs');
    writeFileSync(smoke, 'unrelated smoke test');
    assert.notEqual(shell(guard.run, root, 'false').status, 0);
    assert.equal(shell(guard.run, root, 'true').status, 0);
    rmSync(smoke);
    symlinkSync('missing-target', smoke);
    assert.notEqual(shell(guard.run, root, 'false').status, 0);
    const steps = workflow.jobs[job].steps;
    const publish = step(job, job === 'build' ? 'Create draft pull request' : 'Push repairs');
    assert.ok(steps.indexOf(guard) < steps.indexOf(publish));
  });
}

test('repair inputs are removed before staging the repaired tree', t => {
  const { root } = fixture(t);
  mkdirSync(join(root, 'bin'));
  for (const file of ['AGENT_REQUEST.md', 'AGENT_REPAIR_CONTEXT.md', 'agent-test.log', 'agent-review.json']) writeFileSync(join(root, file), 'input');
  writeFileSync(join(root, 'bin', 'git'), `#!/bin/bash
if [[ "$1" == status ]]; then exit 0; fi
if [[ "$1" == add ]]; then
  for file in AGENT_REQUEST.md AGENT_REPAIR_CONTEXT.md agent-test.log agent-review.json; do
    [[ ! -e "$file" ]] || exit 42
  done
  touch staged-clean
fi
if [[ "$1" == diff ]]; then exit 1; fi
`, { mode: 0o755 });
  writeFileSync(join(root, 'bin', 'gh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const result = shell(step('repair', 'Push repairs').run, root, 'false', {
    PATH: `${join(root, 'bin')}:${process.env.PATH}`, BRANCH: 'test-only',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, 'staged-clean'), 'utf8'), '');
});
