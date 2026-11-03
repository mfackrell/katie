import test from 'node:test';
import assert from 'node:assert/strict';
import { documentRequest, inheritDocumentPageConstraint } from '../lib/documents/intent';
import { contentText, parseDocument } from '../lib/documents/model';

const user = (content: string) => ({ role: 'user', content });
const assistant = (content: string) => ({ role: 'assistant', content });

test('same-document follow-up inherits two-page requirement without selecting document content', () => {
  const first = 'Produce my final two-page résumé as actual Word and PDF files. Inspect the rendered pages.';
  const retry = 'give me the final resume in docx and pdf again. I did not like the formatting of the first attempt';
  const current = documentRequest(retry);
  assert.deepEqual(current, {});
  const result = inheritDocumentPageConstraint(retry, current, [
    user(first), assistant('Created and inspected two pages.'),
    user('give me the final resume in Word and PDF again'),
    assistant('Created another copy.'),
  ]);
  assert.deepEqual(result, { pages: 2 });
  assert.equal(documentRequest(first)?.pages, 2);
});

test('current explicit page count wins and unrelated document or ambiguous retry cannot inherit', () => {
  const history = [user('Produce my final two-page résumé as Word and PDF files.')];
  const current = 'Create a three-page résumé as Word and PDF again.';
  assert.deepEqual(inheritDocumentPageConstraint(current, documentRequest(current), history), { pages: 3 });
  const unrelated = 'Give me the quarterly financial report as PDF again.';
  assert.deepEqual(inheritDocumentPageConstraint(unrelated, documentRequest(unrelated), history), {});
  const ordinary = 'Produce my résumé as a PDF.';
  assert.deepEqual(inheritDocumentPageConstraint(ordinary, documentRequest(ordinary), history), {});
  const anotherDocument = [history[0], user('Produce a four-page financial report as a PDF.')];
  const retry = 'Give me the résumé in PDF again.';
  assert.deepEqual(inheritDocumentPageConstraint(retry, documentRequest(retry), anotherDocument), {});
  assert.deepEqual(inheritDocumentPageConstraint(retry, documentRequest(retry), [
    assistant('Produce a two-page résumé as a PDF.'), user('Prepare my résumé as a PDF.'),
  ]), {});
});

test('standalone emphasized labels remain meaningful document structure without changing wording', () => {
  const markdown = '# Executive profile\n\n## Selected engagements\n\n**Professional Services | Interim Controller**\n\n- Restored accounting controls.\n\n- Reconciled working capital.\n\n**Operating Finance | CFO**\n\n- Built management reports.';
  const spec = parseDocument(markdown, 2);
  assert.deepEqual(spec.blocks.map(b => b.kind), ['heading','heading','heading','bullet','bullet','heading','bullet']);
  assert.deepEqual(spec.blocks.filter(b => b.kind === 'heading').map(b => b.level), [1,2,3,3]);
  assert.ok(contentText(spec).includes('Professional Services | Interim Controller'));
  assert.equal(contentText(spec).includes('**'), false);
  assert.equal(spec.targetPages, 2);
});

test('generalized subsection parsing also supports reports and contracts while retaining tables', () => {
  const report = parseDocument('# Operations review\n\n**Risks and dependencies**\n\nThe close remains a priority.\n\n| Metric | Result |\n| --- | --- |\n| Cash | Stable |');
  assert.deepEqual(report.blocks.map(b => b.kind), ['heading','heading','paragraph','table']);
  const agreement = parseDocument('# Consulting agreement\n\n__Payment terms__\n\nInvoices are payable according to the signed agreement.');
  assert.deepEqual(agreement.blocks.map(b => b.kind), ['heading','heading','paragraph']);
  assert.equal(contentText(agreement).includes('Payment terms'), true);
});
