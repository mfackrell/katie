import test from 'node:test';
import assert from 'node:assert/strict';
import { documentRequest, SAVED_DOCUMENT_EXPORT_PROMPT } from '../lib/documents/intent';

test('production regression: discussing Katie PDF development must remain ordinary chat', () => {
  // Exact November 2 production message, which previously activated document
  // generation and discarded Claude's legitimate conversational response.
  const message = [
    'since when is your backend off limits...',
    "we are trying to get you to generate pdf's and it has been excruciating",
    'we are continueing development of the DO',
    'we are fixing a memory bug that YOU introoduced earlier today and we are working on your iTM layer',
  ].join('\n');
  assert.equal(documentRequest(message), null);
});

test('retrospective, diagnostic and quoted document-generation wording is not an action request', () => {
  for (const message of [
    "We're trying to generate a PDF but the tool is failing",
    'We have been trying to generate a PDF',
    'I tried to generate a PDF yesterday. Why did it fail?',
    'I asked Katie to create a PDF, and she could not do it.',
    'I told you to generate a PDF last week.',
    "I'm working on having you generate a PDF.",
    'We need to fix how you generate PDF files.',
    'Please make sure Katie can generate a PDF.',
    'Please build a PDF generator.',
    'Please create a feature to generate a PDF.',
    'Please build a tool for PDF generation.',
    'Please build an API to generate a PDF.',
    'Please create a PDF rendering pipeline.',
    'Make a PDF exporter that we can use next week.',
    'The last assistant response said to generate a PDF.',
    "Please explain why we can't generate a PDF.",
    'Please tell me why the system failed to generate a PDF.',
    'Katie told me to generate a PDF.',
    'How do you generate a PDF?',
    'Review this PDF and give me the key risks.',
    'Make recommendations about the PDF.',
    "Don't create a PDF.",
  ]) assert.equal(documentRequest(message), null, message);
});

test('affirmative current requests still trigger document production, including after status updates', () => {
  assert.deepEqual(documentRequest('Produce a professionally formatted two-page Word document and PDF'), { pages: 2 });
  assert.deepEqual(documentRequest('Produce my final two-page résumé as actual Word and PDF files.'), { pages: 2 });
  for (const message of [
    'Please generate a PDF.',
    'Katie, please generate a PDF.',
    'Generate a PDF.',
    'Could you generate a PDF?',
    'Can you please create a Word document?',
    'Can you help me convert this to PDF?',
    'I want you to generate a PDF.',
    'We need you to make a PDF.',
    "Let's generate a PDF.",
    "I'd like you to generate a PDF.",
    'Create a summary of this PDF as a Word document.',
    SAVED_DOCUMENT_EXPORT_PROMPT,
    "We've been trying to get you to generate pdf's. Please generate a PDF now.",
  ]) assert.deepEqual(documentRequest(message), {}, message);
});
