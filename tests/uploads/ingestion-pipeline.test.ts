import test from "node:test";
import assert from "node:assert/strict";
import { detectFileType } from "../../lib/uploads/file-type-helpers";
import { parsePdf, __setPdfParserDepsForTests } from "../../lib/uploads/parsers/pdf";
import { parseExcel, __setExcelParserDepsForTests } from "../../lib/uploads/parsers/excel";
import { parsePowerPoint, __setPowerPointParserDepsForTests } from "../../lib/uploads/parsers/powerpoint";
import { parseEmail } from "../../lib/uploads/parsers/email";

function ctx(file: File) {
  return { file, extension: file.name.slice(file.name.lastIndexOf(".")).toLowerCase(), mimeType: file.type };
}

test("file type detection supports common business formats", () => {
  const files = [
    ["a.pdf", "application/pdf", "pdf"],
    ["a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "word"],
    ["a.doc", "application/msword", "word"],
    ["a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "excel"],
    ["a.xls", "application/vnd.ms-excel", "excel"],
    ["a.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "powerpoint"],
    ["a.ppt", "application/vnd.ms-powerpoint", "powerpoint"],
    ["a.eml", "message/rfc822", "email"],
    ["a.msg", "application/vnd.ms-outlook", "email"],
    ["a.html", "text/html", "html"],
    ["a.xml", "application/xml", "xml"],
    ["a.json", "application/json", "json"],
    ["a.png", "image/png", "image"],
    ["a.jpg", "image/jpeg", "image"],
    ["a.webp", "image/webp", "image"]
  ] as const;

  files.forEach(([name, type, format]) => {
    const detected = detectFileType(new File(["x"], name, { type }));
    assert.equal(detected?.sourceFormat, format);
  });
});

test("pdf parser preserves pages and flags scanned-like files", async () => {
  __setPdfParserDepsForTests({
    pdfjs: async () => ({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 2,
          getPage: async (pageNumber: number) => ({
            getTextContent: async () => ({ items: [{ str: pageNumber === 1 ? "Hello" : "World" }] })
          })
        })
      })
    })
  });

  const parsed = await parsePdf(ctx(new File([new Uint8Array([1])], "doc.pdf", { type: "application/pdf" })));
  assert.match(parsed.extractedText ?? "", /--- page 1 ---/);
  assert.equal(parsed.ingestionQuality, "high");

  __setPdfParserDepsForTests({
    pdfjs: async () => ({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({ getTextContent: async () => ({ items: [{ str: "" }] }) })
        })
      })
    })
  });

  const scanned = await parsePdf(ctx(new File([new Uint8Array([1])], "scan.pdf", { type: "application/pdf" })));
  assert.equal(scanned.ingestionQuality, "low");
  assert.ok(scanned.parseWarnings?.[0].includes("OCR fallback"));
});

test("excel parser keeps sheet boundaries, structured data, and truncation warnings", async () => {
  __setExcelParserDepsForTests({
    xlsx: async () => ({
      read: () => ({ SheetNames: ["Summary", "Details"], Sheets: { Summary: {}, Details: {} } }),
      utils: {
        sheet_to_json: (_sheet: unknown) => Array.from({ length: 600 }, (_v, i) => [i === 0 ? "Col" : `r${i}`])
      }
    })
  });

  const parsed = await parseExcel(ctx(new File([new Uint8Array([1])], "book.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })));
  assert.match(parsed.extractedText ?? "", /--- sheet: Summary ---/);
  assert.equal((parsed.structuredData?.workbook as { sheetNames: string[] }).sheetNames.length, 2);
  assert.ok(parsed.parseWarnings?.some((w) => w.includes("truncated")));
});

test("powerpoint parser extracts pptx and rejects ppt clearly", async () => {
  __setPowerPointParserDepsForTests({
    extractSlideXmlFiles: async () => ["<a:t>Title</a:t><a:t>Bullet</a:t>"]
  });

  const parsed = await parsePowerPoint(ctx(new File([new Uint8Array([1])], "deck.pptx", { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" })));
  assert.match(parsed.extractedText ?? "", /slide 1/);

  await assert.rejects(
    parsePowerPoint(ctx(new File([new Uint8Array([1])], "legacy.ppt", { type: "application/vnd.ms-powerpoint" }))),
    /convert the file to \.pptx/
  );
});

test("email parser extracts eml headers/body and rejects msg clearly", async () => {
  const raw = `From: alice@example.com\nTo: bob@example.com\nSubject: Hello\nDate: Thu, 1 Jan 2026 00:00:00 +0000\nContent-Type: text/html\n\n<p>Hi <b>Bob</b></p>`;
  const eml = await parseEmail(ctx(new File([raw], "note.eml", { type: "message/rfc822" })));
  assert.match(eml.extractedText ?? "", /From: alice@example.com/);
  assert.match(eml.extractedText ?? "", /Hi Bob/);

  await assert.rejects(
    parseEmail(ctx(new File(["msg"], "note.msg", { type: "application/vnd.ms-outlook" }))),
    /not yet supported/
  );
});
