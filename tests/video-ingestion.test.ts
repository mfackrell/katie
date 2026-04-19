import test from "node:test";
import assert from "node:assert/strict";
import { buildFileReferences } from "../lib/uploads/build-file-references";
import { __setDynamicImportOverridesForTests } from "../lib/uploads/parse-text-files";
import { inferRequestIntent } from "../lib/router/model-intent";
import { formatAttachmentContext } from "../lib/providers/attachment-context";
import { analyzeChunkedAttachments, shouldRunChunkedWorkflow } from "../lib/providers/chunked-document-workflow";
import { LlmProvider } from "../lib/providers/types";

function withUploadKeysDisabled(fn: () => Promise<void>): Promise<void> {
  const prevOpenAi = process.env.OPENAI_API_KEY;
  const prevGoogle = process.env.GOOGLE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  return fn().finally(() => {
    if (prevOpenAi) {
      process.env.OPENAI_API_KEY = prevOpenAi;
    }
    if (prevGoogle) {
      process.env.GOOGLE_API_KEY = prevGoogle;
    }
  });
}

test("buildFileReferences accepts supported video types", async () => {
  await withUploadKeysDisabled(async () => {
    const files = [
      new File([new Uint8Array([1, 2, 3])], "clip.mp4", { type: "video/mp4" }),
      new File([new Uint8Array([1, 2, 3])], "screen.mov", { type: "video/quicktime" }),
      new File([new Uint8Array([1, 2, 3])], "demo.webm", { type: "video/webm" }),
      new File([new Uint8Array([1, 2, 3])], "recording.m4v", { type: "video/x-m4v" })
    ];

    const refs = await buildFileReferences(files);

    assert.equal(refs.length, 4);
    refs.forEach((ref) => {
      assert.equal(ref.attachmentKind, "video");
      assert.match(ref.preview, /Video attachment metadata only/);
      assert.ok(ref.mimeType.startsWith("video/"));
      assert.equal(ref.extractedText, undefined);
    });
  });
});

test("buildFileReferences successfully ingests PDF files as text attachments", async () => {
  __setDynamicImportOverridesForTests({
    pdfParser: async () => ({
      default: class {
        on(
          event: "pdfParser_dataError" | "pdfParser_dataReady",
          cb: ((err: { parserError?: string }) => void) | ((data: { Pages?: unknown[] }) => void)
        ): void {
          if (event === "pdfParser_dataReady") {
            (cb as (data: { Pages?: unknown[] }) => void)({
              Pages: [{ Texts: [{ R: [{ T: "Quarterly%20report" }] }] }]
            });
          }
        }
        parseBuffer(_buffer: Buffer): void {}
      }
    })
  });

  await withUploadKeysDisabled(async () => {
    const refs = await buildFileReferences([
      new File([new Uint8Array([1, 2, 3])], "report.pdf", { type: "application/pdf" })
    ]);

    assert.equal(refs.length, 1);
    assert.equal(refs[0].attachmentKind, "text");
    assert.equal(refs[0].preview, "Quarterly report");
    assert.equal(refs[0].extractedText, "Quarterly report");
    assert.equal(refs[0].totalChunks, 1);
    assert.equal(refs[0].extractedChunks?.length, 1);

    const attachmentContext = formatAttachmentContext(refs);
    assert.match(attachmentContext, /Full extracted document is available in ordered chunks/);
    assert.match(attachmentContext, /chunk 1\/1/);
    assert.match(attachmentContext, /Quarterly report/);
    assert.doesNotMatch(attachmentContext, /Full file body is intentionally excluded/);
  });
});

test("buildFileReferences successfully ingests XLSX files as text attachments", async () => {
  __setDynamicImportOverridesForTests({
    xlsx: async () => ({
      read: () => ({ SheetNames: ["Sheet1"], Sheets: { Sheet1: {} } }),
      utils: {
        sheet_to_csv: () => "region\trevenue"
      }
    })
  });

  await withUploadKeysDisabled(async () => {
    const refs = await buildFileReferences([
      new File([new Uint8Array([1, 2, 3])], "metrics.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      })
    ]);

    assert.equal(refs.length, 1);
    assert.equal(refs[0].attachmentKind, "text");
    assert.match(refs[0].preview, /sheet: Sheet1/);
    assert.match(refs[0].preview, /region\trevenue/);
    assert.match(refs[0].extractedText ?? "", /sheet: Sheet1/);
    assert.match(refs[0].extractedText ?? "", /region\trevenue/);
  });
});

test("buildFileReferences successfully ingests DOCX files as text attachments", async () => {
  __setDynamicImportOverridesForTests({
    mammoth: async () => ({
      extractRawText: async () => ({ value: "Proposal summary" })
    })
  });

  await withUploadKeysDisabled(async () => {
    const refs = await buildFileReferences([
      new File([new Uint8Array([1, 2, 3])], "proposal.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      })
    ]);

    assert.equal(refs.length, 1);
    assert.equal(refs[0].attachmentKind, "text");
    assert.equal(refs[0].preview, "Proposal summary");
    assert.equal(refs[0].extractedText, "Proposal summary");
  });
});

test("buildFileReferences rejects unsupported extensions", async () => {
  await withUploadKeysDisabled(async () => {
    await assert.rejects(
      buildFileReferences([new File(["malware"], "payload.exe", { type: "application/octet-stream" })]),
      /Allowed types: txt, md, json, csv, docx, doc, xlsx, xls, pdf, mp4, mov, webm, m4v\./
    );
  });
});

test("buildFileReferences uses consistent supported-types messaging", async () => {
  await withUploadKeysDisabled(async () => {
    await assert.rejects(
      buildFileReferences([new File(["oops"], "unsupported.bin", { type: "application/octet-stream" })]),
      /Allowed types: txt, md, json, csv, docx, doc, xlsx, xls, pdf, mp4, mov, webm, m4v\./
    );

    await assert.rejects(
      buildFileReferences([new File([new Uint8Array([9])], "legacy.avi", { type: "video/avi" })]),
      /Allowed types: txt, md, json, csv, docx, doc, xlsx, xls, pdf, mp4, mov, webm, m4v\./
    );
  });
});

test("buildFileReferences rejects mismatched video extension", async () => {
  await withUploadKeysDisabled(async () => {
    await assert.rejects(
      buildFileReferences([new File([new Uint8Array([9])], "not-really-video.txt", { type: "video/mp4" })]),
      /Allowed types: txt, md, json, csv, docx, doc, xlsx, xls, pdf, mp4, mov, webm, m4v\./
    );
  });
});

test("video-bearing requests are not treated as text-only intent", async () => {
  assert.equal(
    await inferRequestIntent("Summarize what happens in this upload.", { hasImages: false, hasVideoInput: true }),
    "vision-analysis"
  );
  assert.equal(
    await inferRequestIntent("Analyze this clip and project the trend over time.", { hasImages: false, hasVideoInput: true }),
    "multimodal-reasoning"
  );
});

test("formatAttachmentContext avoids duplicate extracted body injection", () => {
  const context = formatAttachmentContext([
    {
      fileId: "file-a",
      fileName: "a.pdf",
      mimeType: "application/pdf",
      preview: "preview a",
      extractedText: "same extracted body",
      attachmentKind: "text"
    },
    {
      fileId: "file-b",
      fileName: "b.pdf",
      mimeType: "application/pdf",
      preview: "preview b",
      extractedText: "same   extracted\nbody",
      attachmentKind: "text"
    }
  ]);

  assert.match(context, /Duplicate extracted text omitted/);
  assert.match(context, /preview b/);
});

test("formatAttachmentContext includes ordered chunk windows and partial-context safety note", () => {
  const context = formatAttachmentContext(
    [
      {
        fileId: "chunked-file",
        fileName: "statement.pdf",
        mimeType: "application/pdf",
        preview: "preview",
        extractedChunks: [
          { index: 0, total: 3, text: "opening balance summary" },
          { index: 1, total: 3, text: "wire transfer details and counterparties" },
          { index: 2, total: 3, text: "closing totals and fees" }
        ],
        totalChunks: 3,
        truncatedForContext: true,
        extractionCoverage: "full",
        attachmentKind: "text"
      }
    ],
    { userMessage: "analyze transfer counterparties", maxChunksPerAttachment: 2 }
  );

  assert.match(context, /chunkWindow=2\/3/);
  assert.match(context, /chunk 2\/3/);
  assert.match(context, /Only a relevant subset of chunks was injected/);
});

test("server workflow can iterate across all chunks for large-document analysis", async () => {
  const seenChunkPrompts: string[] = [];
  const provider: LlmProvider = {
    name: "openai",
    listModels: async () => ["mock-model"],
    generate: async (params) => {
      seenChunkPrompts.push(params.user);
      const marker = params.user.match(/chunk (\d+)\/(\d+)/i);
      return {
        text: marker ? `finding-${marker[1]}-of-${marker[2]}` : "summary",
        model: "mock-model",
        provider: "openai"
      };
    }
  };

  assert.equal(
    shouldRunChunkedWorkflow("review this attached statement", [
      {
        fileId: "doc",
        fileName: "doc.pdf",
        mimeType: "application/pdf",
        preview: "preview",
        extractedChunks: [
          { index: 0, total: 2, text: "chunk a" },
          { index: 1, total: 2, text: "chunk b" }
        ]
      }
    ]),
    true
  );

  const prepass = await analyzeChunkedAttachments({
    provider,
    modelId: "mock-model",
    name: "Katie",
    persona: "Helpful assistant",
    summary: "",
    userMessage: "review this attached statement",
    attachments: [
      {
        fileId: "doc",
        fileName: "doc.pdf",
        mimeType: "application/pdf",
        preview: "preview",
        extractedChunks: [
          { index: 0, total: 2, text: "chunk a" },
          { index: 1, total: 2, text: "chunk b" }
        ],
        totalChunks: 2,
        attachmentKind: "text"
      }
    ]
  });

  assert.equal(seenChunkPrompts.length, 2);
  assert.match(prepass, /analyzed across 2\/2 chunks/);
  assert.match(prepass, /finding-1-of-2/);
  assert.match(prepass, /finding-2-of-2/);
});
