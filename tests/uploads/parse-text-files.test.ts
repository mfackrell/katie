import test from "node:test";
import assert from "node:assert/strict";
import {
  __setDynamicImportOverridesForTests,
  convertToPlainText,
  parseTextFiles
} from "../../lib/uploads/parse-text-files";

const DOCX_BASE64 = "UEsDBAoAAAAAA";
const XLSX_BASE64 = "UEsDBAoAAAAAA";
const PDF_BASE64 = "JVBERi0xLjQK";

function fromBase64(base64: string): ArrayBuffer {
  const buffer = Buffer.from(base64, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

test("parseTextFiles converts docx, xlsx, and pdf through type-specific converters", async () => {
  __setDynamicImportOverridesForTests({
    mammoth: async () => ({
      extractRawText: async () => ({ value: "Docx   content\n\n\nWith spacing" })
    }),
    xlsx: async () => ({
      read: () => ({ SheetNames: ["Sheet1"], Sheets: { Sheet1: {} } }),
      utils: {
        sheet_to_csv: () => "cell1\tcell2"
      }
    }),
    pdfParser: async () => ({
      default: class {
        on(
          event: "pdfParser_dataError" | "pdfParser_dataReady",
          cb: ((err: { parserError?: string }) => void) | ((data: { Pages?: unknown[] }) => void)
        ): void {
          if (event === "pdfParser_dataReady") {
            (cb as (data: { Pages?: unknown[] }) => void)({
              Pages: [{ Texts: [{ R: [{ T: "PDF%20text" }] }] }]
            });
          }
        }
        parseBuffer(_buffer: Buffer): void {}
      }
    })
  });

  const files = [
    new File([fromBase64(DOCX_BASE64)], "sample.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }),
    new File([fromBase64(XLSX_BASE64)], "book.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }),
    new File([fromBase64(PDF_BASE64)], "report.pdf", { type: "application/pdf" })
  ];

  const parsed = await parseTextFiles(files);

  assert.equal(parsed[0].sourceFormat, "word");
  assert.equal(parsed[0].text, "Docx   content\n\nWith spacing");
  assert.equal(parsed[1].sourceFormat, "excel");
  assert.equal(parsed[1].text, "--- sheet: Sheet1 ---\ncell1\tcell2");
  assert.equal(parsed[2].sourceFormat, "pdf");
  assert.equal(parsed[2].text, "PDF text");
});

test("PDF parse failures return a clear parse error", async () => {
  __setDynamicImportOverridesForTests({
    pdfParser: async () => ({
      default: class {
        on(
          event: "pdfParser_dataError" | "pdfParser_dataReady",
          cb: ((err: { parserError?: string }) => void) | ((data: { Pages?: unknown[] }) => void)
        ): void {
          if (event === "pdfParser_dataError") {
            (cb as (err: { parserError?: string }) => void)({ parserError: "invalid pdf" });
          }
        }
        parseBuffer(_buffer: Buffer): void {}
      }
    })
  });

  await assert.rejects(
    parseTextFiles([new File([fromBase64(PDF_BASE64)], "broken.pdf", { type: "application/pdf" })]),
    /Failed to parse PDF document "broken\.pdf"\./
  );
});

test("parseTextFiles rejects unsupported extensions", async () => {
  await assert.rejects(
    parseTextFiles([new File(["hello"], "image.png", { type: "image/png" })]),
    /Supported extensions: txt, md, json, csv, docx, doc, xlsx, xls, pdf\./
  );
});

test("parseTextFiles enforces 8MB binary limit", async () => {
  __setDynamicImportOverridesForTests({
    mammoth: async () => ({
      extractRawText: async () => ({ value: "ok" })
    })
  });

  const oversizedDocx = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "big.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });

  await assert.rejects(parseTextFiles([oversizedDocx]), /Maximum file size for this type is 8MB/);
});

test("legacy .doc fallback returns clear error when mammoth fails", async () => {
  __setDynamicImportOverridesForTests({
    mammoth: async () => ({
      extractRawText: async () => {
        throw new Error("bad format");
      }
    })
  });

  const legacyDoc = new File(["binary"], "legacy.doc", { type: "application/msword" });

  await assert.rejects(convertToPlainText(legacyDoc), /Legacy \.doc not supported/);
});

test("extracted text is sanitized and truncated", async () => {
  const huge = `hello\u0000${"a".repeat(50_100)}`;
  const parsed = await parseTextFiles([new File([huge], "plain.txt", { type: "text/plain" })]);

  assert.equal(parsed[0].text.includes("\u0000"), false);
  assert.equal(parsed[0].text.endsWith("[truncated]"), true);
});
