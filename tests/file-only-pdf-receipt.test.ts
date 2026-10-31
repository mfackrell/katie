import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifiedFileOnlyPdfReceipt } from "../lib/chat/file-only-pdf-receipt";
import type { FileReference } from "../lib/providers/types";

const resume: FileReference = {
  fileId: "fresh-resume",
  fileName: "Resume-Mark-Fackrell (1).pdf",
  mimeType: "application/pdf",
  attachmentKind: "text",
  preview: "Partial source preview",
  extractedText: "Operational CFO and financial executive.",
  extractedChunks: [
    { index: 0, total: 2, text: "Operational CFO" },
    { index: 1, total: 2, text: "Financial executive" },
  ],
  extractionCoverage: "partial",
};

test("file-only composer upload acknowledges the exact readable fresh PDF without a provider call", () => {
  const receipt = verifiedFileOnlyPdfReceipt("[file]", [resume], new Set([resume.fileId]));
  assert.ok(receipt);
  assert.match(receipt, /Received "Resume-Mark-Fackrell \(1\)\.pdf"/);
  assert.match(receipt, /I have readable extracted text/);
  assert.match(receipt, /2 text chunks/);
  assert.match(receipt, /Extraction coverage is incomplete/);
  assert.match(receipt, /What would you like me to do with it/);
  assert.doesNotMatch(receipt, /send the file again|cannot see the file|paste the text/i);
  assert.equal(verifiedFileOnlyPdfReceipt(" [files] ", [resume], new Set([resume.fileId])), receipt);
});

test("receipt cannot be triggered by an older, unselected, multiple, or unrelated source", () => {
  const old = { ...resume, fileId: "old-resume" };
  assert.equal(verifiedFileOnlyPdfReceipt("[file]", [resume], new Set([old.fileId])), null);
  assert.equal(verifiedFileOnlyPdfReceipt("[file]", [resume], new Set()), null);
  assert.equal(verifiedFileOnlyPdfReceipt("[file]", [resume], null), null);
  assert.equal(verifiedFileOnlyPdfReceipt("[file]", [resume, old], new Set([resume.fileId, old.fileId])), null);
  assert.equal(verifiedFileOnlyPdfReceipt("[file]", [{ ...resume, mimeType: "text/plain" }], new Set([resume.fileId])), null);
  assert.equal(verifiedFileOnlyPdfReceipt("Read my résumé", [resume], new Set([resume.fileId])), null);
  assert.equal(verifiedFileOnlyPdfReceipt("Tell me a joke", [resume], new Set([resume.fileId])), null);
  assert.equal(verifiedFileOnlyPdfReceipt("[file]", [], new Set([resume.fileId])), null);
});

test("receipt differentiates readable text from metadata-only or uninspected source", () => {
  const missing: FileReference = { ...resume, extractedText: "", extractedChunks: [], extractionCoverage: "preview-only" };
  const receipt = verifiedFileOnlyPdfReceipt("[file]", [missing], new Set([resume.fileId]));
  assert.ok(receipt);
  assert.match(receipt, /no readable text was extracted/);
  assert.doesNotMatch(receipt, /I have readable extracted text/);
});

test("actual chat route persists uploaded source with the local receipt, before any model dispatch", () => {
  const route = readFileSync("app/api/chat/route.ts", "utf8");
  const select = route.indexOf("verifiedFileOnlyPdfReceipt(message, newAttachments, freshPdfSelection?.fileIds)");
  const persist = route.indexOf("if (pdfProgress.projectClarification || fileOnlyPdfReceipt)");
  const model = route.indexOf('console.log("[Chat API] Assembling context and selecting provider...")');
  assert.ok(select > 0 && select < persist && persist < model);
  assert.match(route, /clarificationAttachments\.push\(\{\.\.\.saved, conversationUsage: "uploaded"\}\)/);
  assert.match(route, /fileOnlyPdfReceipt \? \{reason: "upload-receipt" as const,text:fileOnlyPdfReceipt\}/);
  assert.match(route, /await completeChatRequest\(requestId, \{/);
  assert.match(route, /if \(localKatieResponse\) \{/);
  assert.match(route, /const localUserMessageId = pdfProgress\.projectClarification \|\| fileOnlyPdfReceipt \? taskProgressUserMessageId/);
});
