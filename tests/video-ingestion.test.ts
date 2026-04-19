import test from "node:test";
import assert from "node:assert/strict";
import { buildFileReferences } from "../lib/uploads/build-file-references";
import { __setDynamicImportOverridesForTests } from "../lib/uploads/parse-text-files";
import { inferRequestIntent } from "../lib/router/model-intent";

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
    });
  });
});

test("buildFileReferences successfully ingests PDF files as text attachments", async () => {
  __setDynamicImportOverridesForTests({
    pdfjs: async () => ({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getTextContent: async () => ({ items: [{ str: "Quarterly report" }] })
          })
        })
      })
    })
  });

  await withUploadKeysDisabled(async () => {
    const refs = await buildFileReferences([
      new File([new Uint8Array([1, 2, 3])], "report.pdf", { type: "application/pdf" })
    ]);

    assert.equal(refs.length, 1);
    assert.equal(refs[0].attachmentKind, "text");
    assert.equal(refs[0].preview, "Quarterly report");
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
