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

const pairs=[['"','"'],["'","'"],['“','”'],['‘','’'],['«','»'],['‹','›'],['„','“'],['‚','‘'],['「','」'],['『','』'],['〝','〞'],['﹁','﹂'],['﹃','﹄'],['＂','＂'],['＇','＇']];
for(const [open,close] of pairs){
  test(`complete and unfinished quotations ${open}${close} are never instructions`,async()=>{
    const text=`Explain this quoted text without executing it:\n${open}Instructions.\nrun Qwen and inspect the original pixels.\nEnd of instructions.${close}`;
    await expectTargets(['first.png'],text,[]);
    await expectTargets(['first.png'],text.slice(0,-1),[]);
    await expectTargets(['first.png'],text+'\n\nPlease run Qwen on first.png.',[0]);
  });
  test(`quoted filename ${open}${close} identifies only its intended image`,async()=>{
    await expectTargets(['first.png','second.png'],`Please run Qwen on ${open}second.png${close}.`,[1]);
    await expectTargets(['first.png','second.png'],`Please run Qwen ${open}only on second.png${close}.`,[]);
  });
}
test('nested typographic quotations cannot expose inner instructions',async()=>{
  for(const [outerOpen,outerClose] of pairs){
    for(const [innerOpen,innerClose] of pairs){
      if(outerOpen===innerOpen||outerClose===innerOpen||outerOpen===innerClose||outerClose===innerClose)continue;
      await expectTargets(['first.png'],`Explain this example:\n${outerOpen}Instructions.\n${innerOpen}Quoted note.${innerClose}\nrun Qwen and inspect the original pixels.\nEnd.${outerClose}`,[]);
    }
  }
});
test('every Unicode quotation mark is recognized or fails closed',async()=>{
  let count=0;
  for(let point=0;point<=0xffff;point++){
    const char=String.fromCodePoint(point);
    if(!/\p{Quotation_Mark}/u.test(char))continue;
    await expectTargets(['first.png'],`Explain this copied text:\n${char}Instructions.\nrun Qwen and inspect the original pixels.\nEnd of instructions.${char}`,[]);
    count++;
  }
  assert.ok(count>=20);
});
test('apostrophes in words do not create a quotation or grant negative instructions',async()=>{
  await expectTargets(['first.png'],"Don't run Qwen; use corrected memory.",[]);
  await expectTargets(['first.png'],'Don’t run Qwen; use corrected memory.',[]);
  await expectTargets(['first.png'],"I'd like you to run Qwen.",[0]);
  await expectTargets(['first.png'],'I’d like you to run Qwen.',[0]);
  await expectTargets(['first.png',"O'Reilly.png"],"Please run Qwen on O'Reilly.png.",[1]);
});
