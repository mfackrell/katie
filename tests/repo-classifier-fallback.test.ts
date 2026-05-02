import test from 'node:test';
import assert from 'node:assert/strict';
import { __resolveRepoSourceClassifierFailureForTests } from '../lib/chat/repo-source-classifier-fallback';

test('repo classifier falls open when active repo and enabled', () => {
  process.env.REPO_CLASSIFIER_FALL_OPEN = 'true';
  const result = __resolveRepoSourceClassifierFailureForTests(true);
  assert.equal(result.attach_repo_source, true);
  assert.equal(result.reason, 'classifier_unavailable_fall_open');
});

test('repo classifier fail-closed when inactive repo', () => {
  process.env.REPO_CLASSIFIER_FALL_OPEN = 'true';
  const result = __resolveRepoSourceClassifierFailureForTests(false);
  assert.equal(result.attach_repo_source, false);
});
