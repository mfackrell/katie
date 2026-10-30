import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync('components/chat-panel.tsx', 'utf8');
const start = source.indexOf('function reviewStatusMessage(');
const end = source.indexOf('const IMAGE_OBSERVATION_STAGES', start);
function statusMessage(review) {
  assert.ok(start >= 0 && end > start, 'review status formatter must exist');
  const context = vm.createContext({});
  vm.runInContext(ts.transpileModule(source.slice(start, end) + '\\nglobalThis.formatReview = reviewStatusMessage;', {
    compilerOptions: {target: ts.ScriptTarget.ES2022}
  }).outputText, context);
  return context.formatReview(review);
}

test('review progress is visible without exposing the draft', () => {
  assert.equal(statusMessage({mode:'always',status:'in_progress',detail:'Comparing the draft against requirements.'}), 'Comparing the draft against requirements.');
  assert.match(statusMessage({mode:'always',status:'in_progress'}), /reviewing/i);
  assert.match(statusMessage({mode:'always',status:'revised'}), /review finished/i);
});

test('both streamed and trailing review events are consumed before generic metadata', () => {
  const stream = source.indexOf('if (chunk.type === "metadata" && chunk.review)');
  const generic = source.indexOf('if (chunk.type === "metadata")', stream);
  const trailing = source.indexOf('if (trailingChunk.type === "metadata" && trailingChunk.review)');
  assert.ok(stream >= 0 && generic > stream, 'review-only metadata must not clear selected model');
  assert.ok(trailing > generic, 'trailing review event must also update the status');
  assert.match(source.slice(stream, generic), /setStatusMessage\\(reviewStatusMessage\\(chunk.review\\)\\)/);
  assert.match(source.slice(trailing, trailing + 190), /setStatusMessage\\(reviewStatusMessage\\(trailingChunk.review\\)\\)/);
});
