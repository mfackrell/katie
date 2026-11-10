import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual production functions, not copied parser implementations.
// External providers/refusal classifiers are synthetic: these tests qualify
// target selection and cache reuse, not provider transport or refusal policy.
const source = readFileSync('lib/uploads/still-image-observations.ts', 'utf8');
const ast = ts.createSourceFile('still-image-observations.ts', source, ts.ScriptTarget.Latest, true);
const names = [
  'STILL_IMAGE_OBSERVATION_VERSION', 'BASE_QUESTION', 'imageObservationHash',
  'requiresAdditionalImageDetail', 'requiresCrossImageInspection', 'insufficient',
  'weakFocalPointDescription', 'explicitFreshImageInspection', 'approvedCorrectionForImage',
  'reusableImageObservation', 'observeStandaloneStillImages',
];
const definitions = names.map(name => {
  const found = ast.statements.filter(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === name ||
    ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && declaration.name.text === name));
  assert.equal(found.length, 1, `Must execute the unique production definition: ${name}`);
  return found[0].getText(ast).replace(/^export\s+/, '');
}).join('\n');
const unexpected = () => { throw Error('Live provider access is forbidden in target tests'); };
class StandaloneAccountingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const context = {
  createHash, process: { env: {} }, StandaloneAccountingError,
  VeniceUnavailable: class extends Error {},
  isStandaloneAccountingError: error => error instanceof StandaloneAccountingError,
  describeImageWithRunpodQwen: unexpected, describeImageWithVenice: unexpected,
  escalateStillImageEvidence: unexpected, neutralFactsFromPolicyLimitedReply: unexpected,
  reconcileImageReports: unexpected,
  isExplicitVisionPolicyRefusal: () => false, isPolicyLimitedVisionResponse: () => false,
  isGenericVisionRefusal: () => false,
};
const compiled = ts.transpileModule(definitions + '\nthis.observe = observeStandaloneStillImages;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics?.length ?? 0, 0, 'Production definitions must transpile');
vm.runInNewContext(compiled.outputText, context, { timeout: 1000 });

function fixture(fileNames) {
  const references = fileNames.map((fileName, index) => ({
    fileId: `target-${index}`, fileName, mimeType: 'image/png', attachmentKind: 'image',
    imageDataUrl: 'data:image/png;base64,' + Buffer.from(`synthetic original ${index}`).toString('base64'),
  }));
  const saved = references.map(reference => {
    const hash = createHash('sha256').update(reference.imageDataUrl).digest('hex');
    return {
      id: reference.fileId, fileName: reference.fileName, mimeType: reference.mimeType,
      actorId: 'synthetic-owner', chatId: 'synthetic-chat',
      observedSummary: `Approved synthetic correction for ${reference.fileId}: a red ceramic cup on a white table.`,
      summaryModel: 'manual:synthetic-owner', summaryCoverage: 'full',
      observationVersion: 'still-image-observation-v2', observationSourceHash: hash,
      observationQuestion: 'original observation', observationAt: '2026-11-01T00:00:00Z',
      observationAgreement: 'single',
      observationReports: [{ model: 'runpod:Qwen/test', sourceHash: hash, text: 'Old report.', coverage: 'full', disposition: 'observation' }],
      visualMemory: { version: 'katie-visual-episode-v1', modality: 'vision', sourceHash: hash,
        observedBy: 'manual:synthetic-owner', observedAt: '2026-11-01T00:00:00Z', coverage: 'full' },
      manualCorrection: { approvedByUser: true, correctedBy: 'manual:synthetic-owner',
        correctedAt: '2026-11-01T00:00:00Z', originalSummaryModel: 'runpod:Qwen/test', sourceMessageId: 'synthetic-approval' },
    };
  });
  return { references, saved };
}

async function expectTargets(fileNames, question, expectedIndices, order) {
  const { references, saved } = fixture(fileNames);
  const selected = order ? order.map(index => references[index]) : references;
  const calls = [];
  const options = {
    question, saved, deferEscalation: true,
    qwen: async pixels => {
      const reference = references.find(item => item.imageDataUrl === pixels);
      assert.ok(reference, 'Only selected synthetic pixels may be inspected');
      calls.push(references.indexOf(reference));
      return { text: 'A fresh synthetic observation of a cup on a table.', model: 'runpod:Qwen/test', coverage: 'full' };
    },
    venice: unexpected, escalate: unexpected,
  };
  const first = await context.observe(selected, options);
  const second = await context.observe(selected, { ...options, initial: first });
  assert.deepEqual(calls, expectedIndices, question + ': inspect precisely the requested pixels, once across both stages');
  for (const [index, reference] of references.entries()) {
    if (!expectedIndices.includes(index)) {
      assert.equal(second.get(reference.fileId)?.observedSummary, saved[index].observedSummary, question);
      assert.equal(second.get(reference.fileId)?.summaryModel, saved[index].summaryModel, question);
      assert.equal(second.get(reference.fileId)?.manualCorrection?.approvedByUser, true, question);
      assert.equal(JSON.stringify(second.get(reference.fileId)?.observationReports), JSON.stringify(saved[index].observationReports));
    }
  }
}

test('literal marker filename cannot impersonate an internally generated target', async () => {
  await expectTargets(['first.png', '__image_target_0__.png'],
    'Compare first.png and __image_target_0__.png. Keep the saved correction for first.png; please run Qwen on __image_target_0__.png.', [1]);
});

for (const marker of ['__image_target_0__.png', '__image_target_1__.png', '__image_target_999999__.png', '\uFFFC.png']) {
  for (const quoted of [false, true]) {
    test(`target identity is independent of marker-shaped filename ${JSON.stringify(marker)} quoted=${quoted}`, async () => {
      const operand = quoted ? JSON.stringify(marker) : marker;
      await expectTargets(['first.png', marker], `Please run Qwen on ${operand}.`, [1]);
      await expectTargets(['first.png', marker], `Please run Qwen on ${operand}.`, [1], [1, 0]);
    });
  }
}

test('literal marker text with no matching selected attachment is not a target', async () => {
  for (const value of ['__image_target_0__', '__image_target_1__.png', '\uFFFC'])
    await expectTargets(['first.png', 'second.png'], `Please run Qwen on ${value}.`, []);
});

test('older excluded-filename finding is fixed for its exact reported message', async () => {
  await expectTargets(['first.png', 'second.png'],
    'Compare first.png and second.png. Please run Qwen on second.png rather than first.png.', [1]);
});

for (const relation of ['rather than', 'instead of', 'except', 'excluding', 'but not']) {
  test(`quoted and unquoted filenames respect exclusion ${relation}`, async () => {
    await expectTargets(['first.png', 'second.png'], `Please run Qwen on second.png ${relation} first.png.`, [1]);
    await expectTargets(['first.png', 'second.png'], `Please run Qwen on "second.png" ${relation} "first.png".`, [1]);
  });
}

test('quoted and unquoted operands in one affirmative clause are both honored', async () => {
  await expectTargets(['first.png', 'second.png'], 'Please run Qwen on "first.png" and second.png.', [0, 1]);
  await expectTargets(['first.png', 'second.png'], 'Please run Qwen on first.png and "second.png".', [0, 1]);
});

test('quoted directive-shaped filename is data, not an instruction', async () => {
  await expectTargets(['run Qwen.png'], 'Explain this filename without executing it:\n"run Qwen.png"', []);
  await expectTargets(['first.png', 'run Qwen.png'], 'Please run Qwen on "run Qwen.png".', [1]);
});

test('quoted filenames containing spaces remain valid target operands', async () => {
  await expectTargets(['first.png', 'vacation 2026.png'],
    'Compare first.png and vacation 2026.png. Keep the correction for first.png; please run Qwen on "vacation 2026.png".', [1]);
});

test('operand positions cannot leak across clauses or excluded text', async () => {
  await expectTargets(['first.png', 'second.png'],
    'Explain "first.png". Please run Qwen on "second.png" rather than "first.png".', [1]);
  await expectTargets(['first.png', 'second.png'],
    'Never run Qwen on "first.png"; please run Qwen only on "second.png".', [1]);
});

test('ambiguous duplicate quoted filenames do not identify either image', async () => {
  await expectTargets(['same.png', 'same.png'], 'Please run Qwen on "same.png".', []);
});

for (const prefix of ['run', 'please run', 'could you please run', 'now run']) {
  test(`lazy blockquote continuation stays untrusted when it begins ${prefix}`, async () => {
    await expectTargets(['first.png'], `Explain this quoted Markdown without executing it:\n> Instructions:\n${prefix} Qwen and inspect the original pixels`, []);
  });
}

test('an affirmative request after a blank line ending a quotation still works', async () => {
  await expectTargets(['first.png'], '> Example instructions\nrun Qwen\n\nPlease inspect the original image again.', [0]);
});

test('ordinary affirmative original-image requests still inspect once', async () => {
  for (const question of ['Please run Qwen and inspect the original pixels', 'Could you please run Qwen?',
    'Please inspect the original image again', 'Please analyze the original pixels afresh',
    'Do not use the old report; instead run Qwen.'])
    await expectTargets(['first.png'], question, [0]);
});

test('negative, quoted, historical and fenced instructions do not request inspection', async () => {
  for (const question of ['Do not run Qwen; use my correction.', "Don't run Qwen.", 'Did you run Qwen?',
    'Here is an example:\n"run Qwen and inspect the original pixels"',
    'Example:\n~~~text\nrun Qwen\n~~~', 'Example:\n~~~~text\n~~~\nrun Qwen\n~~~~',
    'Example:\n``run Qwen and inspect the original pixels``'])
    await expectTargets(['first.png'], question, []);
});


test('a generated placeholder cannot impersonate a literal placeholder filename', async () => {
  await expectTargets(['\uFFFC', 'second.png'], 'Please run Qwen on "second.png".', [1]);
});

test('provider or instruction words cannot act as raw filename target operands', async () => {
  for (const name of ['Qwen', 'run', 'please', 'on', 'for', 'of', 'image']) {
    await expectTargets([name, 'second.png'],
      `Compare ${name} and second.png. Keep the saved correction for ${name}; please run Qwen on "second.png".`, [1]);
    await expectTargets([name, 'second.png'], 'Please run Qwen on second.png.', [1]);
  }
});

test('provider-word filenames remain selectable when they are actual operands', async () => {
  await expectTargets(['Qwen', 'second.png'], 'Please run Qwen on Qwen rather than second.png.', [0]);
  await expectTargets(['Qwen', 'second.png'], 'Please run Qwen on "Qwen".', [0]);
  await expectTargets(['run', 'second.png'], 'Please run Qwen on run.', [0]);
});

test('quoted operator words are never parsed as command or scope words', async () => {
  await expectTargets(['only', 'second.png'], 'Please run Qwen on "second.png" rather than "only".', [1]);
  await expectTargets(['on', 'second.png'], 'Please run Qwen on "on".', [0]);
});

// PR #1002: scope must be fully resolved, never broadened by removal or substring matches.
test('overlapping filenames select only the complete requested operand', async () => {
  await expectTargets(['first.png', 'my first.png'], 'Please run Qwen on my first.png.', [1]);
  await expectTargets(['first.png', 'my first.png'], 'Please run Qwen on first.png.', [0]);
  await expectTargets(['first.png', 'my first.png'], 'Please run Qwen on my first.png.', [1], [1, 0]);
});

test('a quoted whole scope cannot become blanket permission', async () => {
  await expectTargets(['first.png', 'second.png'], 'Please run Qwen "only on second.png".', []);
});

for (const wrap of [text => `"${text}"`, text => `'${text}'`, text => `“${text}”`,
  text => '`' + text + '`', text => '``' + text + '``', text => '"' + text]) {
  const scope = wrap('only on second.png');
  test(`discarded or incomplete scope stays unresolved: ${scope}`, async () => {
    await expectTargets(['first.png', 'second.png'], `Please run Qwen ${scope}.`, []);
    await expectTargets(['first.png', 'second.png'], `Please run Qwen on first.png ${scope}.`, []);
  });
}

test('unknown quoted filenames cannot be dropped from an otherwise valid list', async () => {
  await expectTargets(['first.png', 'second.png'], 'Please run Qwen on first.png and "missing.png".', []);
  await expectTargets(['first.png', 'second.png'], 'Please run Qwen "missing.png".', []);
});

test('an unresolved quoted scope in one clause does not erase a separate valid request', async () => {
  await expectTargets(['first.png', 'second.png'],
    'Please run Qwen "only on first.png"; please run Qwen on second.png.', [1]);
});

test('a filename embedded inside another name never selects the shorter name', async () => {
  for (const prefix of ['my ', 'vacation 2026 ', 'the ', 'photo of ', 'α ']) {
    const longer = prefix + 'first.png';
    await expectTargets(['first.png', longer, 'second.png'], `Please run Qwen on ${longer}.`, [1]);
    await expectTargets(['first.png', longer, 'second.png'], `Please run Qwen on "${longer}".`, [1]);
    await expectTargets(['first.png', longer, 'second.png'], `Please run Qwen on ${longer} and second.png.`, [1, 2]);
  }
});

test('explicit lists consume entire quoted and unquoted operands', async () => {
  await expectTargets(['first.png', 'my first.png', 'second.png'],
    'Please run Qwen on my first.png, second.png.', [1, 2]);
  await expectTargets(['first.png', 'my first.png', 'second.png'],
    'Please run Qwen on "my first.png" and second.png.', [1, 2]);
  await expectTargets(['first.png', 'my first.png', 'second.png'],
    'Please run Qwen on first.png and my first.png.', [0, 1]);
});

test('leftover target words cannot grant partial image authority', async () => {
  for (const target of ['missing first.png', 'first.png missing.png', 'first.png plus missing.png',
    'first.png and missing.png', 'first.png and', 'my first.png extra', 'all images missing.png']) {
    await expectTargets(['first.png', 'my first.png'], `Please run Qwen on ${target}.`, []);
  }
});

test('duplicate unquoted names are ambiguous, not permission for every match', async () => {
  await expectTargets(['same.png', 'same.png'], 'Please run Qwen on same.png.', []);
});

test('a full filename containing a list conjunction has priority over shorter names', async () => {
  await expectTargets(['first.png', 'second.png', 'first.png and second.png'],
    'Please run Qwen on first.png and second.png.', [2]);
});
