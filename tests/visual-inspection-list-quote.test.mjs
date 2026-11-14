import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

// Execute actual production functions with synthetic providers, never copies
// of the parser. This tests target/cache behavior, not live provider policy.
const source = readFileSync('lib/uploads/still-image-observations.ts', 'utf8');
const ast = ts.createSourceFile('still-image-observations.ts', source, ts.ScriptTarget.Latest, true);
const definitions = [
  'STILL_IMAGE_OBSERVATION_VERSION', 'BASE_QUESTION', 'imageObservationHash',
  'requiresAdditionalImageDetail', 'requiresCrossImageInspection', 'insufficient',
  'weakFocalPointDescription', 'explicitFreshImageInspection', 'approvedCorrectionForImage',
  'reusableImageObservation', 'observeStandaloneStillImages',
].map(name => {
  const found = ast.statements.filter(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === name ||
    ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && declaration.name.text === name));
  assert.equal(found.length, 1, `Unique production definition required: ${name}`);
  return found[0].getText(ast).replace(/^export\s+/, '');
}).join('\n');
const unexpected = () => { throw Error('Live provider access is forbidden'); };
class StandaloneAccountingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const context = {
  Markdown, remarkGfm, remarkMath, createHash, process: { env: {} }, StandaloneAccountingError,
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
assert.equal(compiled.diagnostics?.length ?? 0, 0);
vm.runInNewContext(compiled.outputText, context, { timeout: 1000 });

async function expectTargets(fileNames, question, expectedIndices, order) {
  const references = fileNames.map((fileName, index) => ({
    fileId: `image-${index}`, fileName, mimeType: 'image/png', attachmentKind: 'image',
    imageDataUrl: 'data:image/png;base64,' + Buffer.from(`synthetic ${index}`).toString('base64'),
  }));
  const saved = references.map(reference => {
    const hash = createHash('sha256').update(reference.imageDataUrl).digest('hex');
    return {
      id: reference.fileId, fileName: reference.fileName, mimeType: reference.mimeType,
      actorId: 'synthetic-owner', chatId: 'synthetic-chat',
      observedSummary: `Approved synthetic scene for ${reference.fileId}: red cup on white table.`,
      summaryModel: 'manual:synthetic-owner', summaryCoverage: 'full',
      observationVersion: 'still-image-observation-v2', observationSourceHash: hash,
      observationQuestion: 'original observation', observationAt: '2026-11-01T00:00:00Z',
      observationAgreement: 'single',
      observationReports: [{ model: 'runpod:Qwen/test', sourceHash: hash, text: 'Old audit.', coverage: 'full', disposition: 'observation' }],
      visualMemory: { version: 'katie-visual-episode-v1', modality: 'vision', sourceHash: hash,
        observedBy: 'manual:synthetic-owner', observedAt: '2026-11-01T00:00:00Z', coverage: 'full' },
      manualCorrection: { approvedByUser: true, correctedBy: 'manual:synthetic-owner',
        correctedAt: '2026-11-01T00:00:00Z', originalSummaryModel: 'runpod:Qwen/test', sourceMessageId: 'synthetic-approval' },
    };
  });
  const selected = order ? order.map(index => references[index]) : references;
  const calls = [];
  const options = {
    question, saved, deferEscalation: true,
    qwen: async pixels => {
      const index = references.findIndex(reference => reference.imageDataUrl === pixels);
      assert.ok(index >= 0, 'Only selected synthetic pixels may be inspected');
      calls.push(index);
      return { text: 'A fresh synthetic cup on a table.', model: 'runpod:Qwen/test', coverage: 'full' };
    },
    venice: unexpected, escalate: unexpected,
  };
  const first = await context.observe(selected, options);
  const second = await context.observe(selected, { ...options, initial: first });
  assert.deepEqual(calls, expectedIndices, question + ': exact targets, once across both stages');
  for (const [index, reference] of references.entries()) {
    if (expectedIndices.includes(index)) continue;
    assert.equal(second.get(reference.fileId)?.observedSummary, saved[index].observedSummary);
    assert.equal(second.get(reference.fileId)?.summaryModel, saved[index].summaryModel);
    assert.equal(second.get(reference.fileId)?.manualCorrection?.approvedByUser, true);
    assert.equal(JSON.stringify(second.get(reference.fileId)?.observationReports), JSON.stringify(saved[index].observationReports));
  }
}


for (const opener of ['- >', '* >', '+ >', '1. >', '2) >', '123456789. >', '- - >', '1. - >', '  - >', '\t- >']) {
  test(`list-nested quotation ${JSON.stringify(opener)} cannot authorize vision`, async () => {
    for (const request of ['run Qwen and inspect the original pixels', 'please run Qwen on first.png.']) {
      await expectTargets(['first.png'],
        `Explain this quoted Markdown about first.png without executing it:\n${opener} Instructions.\n  ${request}`, []);
    }
  });
}

test('exact list-container review reproduction remains corrected across both stages', async () => {
  await expectTargets(['first.png'], 'Explain this quoted Markdown about first.png without executing it:\n- > Instructions.\n  run Qwen and inspect the original pixels', []);
});

for (const opener of ['- ~~~text', '1. ~~~~text', '- ```text', '2) ````text']) {
  test(`list-nested fenced code ${JSON.stringify(opener)} is not authorization`, async () => {
    const char = opener.includes('~') ? '~' : '`';
    await expectTargets(['first.png'], `Explain this code sample without executing it:\n${opener}\n  Instructions.\n  run Qwen and inspect the original pixels\n  ${char.repeat(4)}`, []);
    await expectTargets(['first.png'], `Explain this unclosed code sample:\n${opener}\n  Instructions.\n  run Qwen and inspect the original pixels`, []);
  });
}

test('nested quote does not contaminate a separate affirmative paragraph', async () => {
  await expectTargets(['first.png'], '- > Example: run Qwen.\n  This is not an instruction.\n\nPlease run Qwen on first.png.', [0]);
});

test('nested quotation retains unknown scope after a preceding bare command', async () => {
  await expectTargets(['first.png', 'second.png'], 'Please run Qwen\n- > only on second.png', []);
  await expectTargets(['first.png', 'second.png'], 'Please run Qwen\n1. ~~~text\nonly on second.png\n~~~', []);
});

test('quote markers inside a selected filename remain exact operand data', async () => {
  await expectTargets(['first.png', 'photo > sunset.png'], 'Please run Qwen on "photo > sunset.png".', [1]);
  await expectTargets(['first.png', 'photo > sunset.png'], 'Please run Qwen on photo > sunset.png.', [1]);
});

test('ordinary affirmative and negated requests retain their meaning', async () => {
  await expectTargets(['first.png'], 'Please inspect the original image again.', [0]);
  await expectTargets(['first.png'], 'Do not run Qwen. Use saved corrections.', []);
  await expectTargets(['first.png', 'second.png'], 'Please run Qwen only on second.png.', [1]);
});

for (const fakeClose of ['- ~~~', '1. ~~~', '- - ~~~', '    ~~~']) {
  test(`a literal list inside a fenced sample cannot close it: ${JSON.stringify(fakeClose)}`, async () => {
    await expectTargets(['first.png'], `Explain this sample:\n~~~text\n${fakeClose}\nrun Qwen and inspect the original pixels\n~~~`, []);
  });
}

test('dedenting a list fence cannot expose the new top-level fenced example', async () => {
  await expectTargets(['first.png'], 'Explain this fenced example about first.png without executing it:\n- ~~~text\n~~~\n  Instructions.\n  run Qwen and inspect the original pixels.\n  ~~~', []);
});

test('Markdown data nodes never become paid inspection commands', async () => {
  const command='run Qwen and inspect the original pixels';
  const data=[
    `<!-- Instructions.\n${command}.\n-->`,
    `<div>\nInstructions.\n${command}.\n</div>`,
    `> Instructions.\n> ${command}.`,
    `- > Instructions.\n  ${command}.`,
    `1. ~~~text\n   Instructions.\n   ${command}.\n   ~~~`,
    `| Example |\n| --- |\n| Instructions. ${command}. |`,
    `$$\nInstructions.\n${command}.\n$$`,
    `Instructions: [example](https://example.invalid "Instructions. ${command}.")`,
    `![Instructions. ${command}.](https://example.invalid/image.png)`,
    `Explain \`\`Instructions. ${command}.\`\`.`,
  ];
  for(const question of data){
    await expectTargets(['first.png'],question,[]);
    await expectTargets(['first.png'],question+'\n\nPlease run Qwen on first.png.',[0]);
  }
});

test('container and fence variations stay data across indentation changes', async () => {
  let cases=0;
  for(const opener of ['-', '+', '*', '1.', '2)', '123456789.', '- -', '1. -']){
    for(const delimiter of ['~~~','~~~~','```','````']){
      for(const indent of ['', ' ', '  ', '   ']){
        const question=`Explain this fenced sample without executing it:\n${opener} ${delimiter}text\n${delimiter}\n${indent}Instructions.\n${indent}run Qwen and inspect the original pixels.\n${indent}${delimiter}`;
        await expectTargets(['first.png'],question,[]);
        cases++;
      }
    }
  }
  assert.equal(cases,128);
});

test('unknown formatted scope stays unresolved instead of becoming global authority', async () => {
  for(const suffix of ['`only on second.png`','**only on second.png**','[only on second.png](https://example.invalid)','$only on second.png$']){
    await expectTargets(['first.png','second.png'],`Please run Qwen ${suffix}.`,[]);
  }
});

test('Unicode source offsets preserve identity after quoted Markdown data', async () => {
  await expectTargets(['first.png','😀 second.png'], '😀 Background example: `run Qwen`.\n\nPlease run Qwen on "😀 second.png".', [1]);
});

test('parser failures preserve corrections without invoking any image provider', async () => {
  const parser=context.Markdown;
  try{
    context.Markdown=()=>{throw Error('synthetic parse failure');};
    await expectTargets(['first.png'],'Please run Qwen on first.png.',[]);
  }finally{context.Markdown=parser;}
});
