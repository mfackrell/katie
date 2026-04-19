import test from "node:test";
import assert from "node:assert/strict";
import { buildFileReferences, __setUploadDepsForTests } from "../../lib/uploads/build-file-references";
import { __setPdfParserDepsForTests } from "../../lib/uploads/parsers/pdf";

__setPdfParserDepsForTests({
  pdfjs: async () => ({
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({ getTextContent: async () => ({ items: [{ str: "PDF text" }] }) })
      })
    })
  })
});

test("buildFileReferences records provider upload warnings and preserves parsed fields", async () => {
  __setUploadDepsForTests({
    uploadToOpenAi: async () => {
      throw new Error("openai down");
    },
    uploadToGoogle: async () => {
      throw new Error("google down");
    }
  });

  const refs = await buildFileReferences([new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" })]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].sourceFormat, "pdf");
  assert.ok(refs[0].preview.length > 0);
  assert.ok(refs[0].parseWarnings?.some((w) => w.includes("OpenAI native file upload failed")));
  assert.ok(refs[0].parseWarnings?.some((w) => w.includes("Google native file upload failed")));
});

test("buildFileReferences supports image and text routes", async () => {
  __setUploadDepsForTests({ uploadToOpenAi: async () => undefined, uploadToGoogle: async () => undefined });

  const refs = await buildFileReferences([
    new File(["hello"], "notes.txt", { type: "text/plain" }),
    new File([new Uint8Array([137, 80, 78, 71])], "img.png", { type: "image/png" })
  ]);

  const textRef = refs.find((r) => r.fileName === "notes.txt");
  const imageRef = refs.find((r) => r.fileName === "img.png");

  assert.equal(textRef?.attachmentKind, "text");
  assert.ok((textRef?.extractedText ?? "").includes("hello"));
  assert.equal(imageRef?.attachmentKind, "image");
  assert.equal(imageRef?.extractedText, undefined);
});
