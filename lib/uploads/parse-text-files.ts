import { createHash } from "node:crypto";
import type { PdfInventory } from "./pdf-inventory";
import { inventoryPdf } from "./pdf-inventory";
import {
  detectFileType,
  getFileExtension,
  isLegacyWordType,
  isTextSourceFormat,
  supportedExtensionsForError,
  type SourceFormat
} from "@/lib/uploads/file-type-helpers";

type MammothModule = {
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
};

type XlsxWorkbook = {
  SheetNames: string[];
  Sheets: Record<string, unknown>;
};

type XlsxModule = {
  read(data: ArrayBuffer, opts: { type: "array" }): XlsxWorkbook;
  utils: {
    sheet_to_csv(sheet: unknown, options: { FS: string }): string;
  };
};

type PdfTextSegment = {
  T?: string;
};

type PdfTextRun = {
  [key: string]: unknown;
  R?: PdfTextSegment[];
};

type PdfPage = {
  [key: string]: unknown;
  Texts?: PdfTextRun[];
};

type PdfData = {
  Pages?: PdfPage[];
};

type PdfParser = {
  on(event: "pdfParser_dataError", cb: (err: { parserError?: string }) => void): void;
  on(event: "pdfParser_dataReady", cb: (data: PdfData) => void): void;
  parseBuffer(buffer: Buffer): void;
};

type PdfParserModule = {
  default: new () => PdfParser;
};

type DynamicImportLoaders = {
  mammoth: () => Promise<MammothModule>;
  xlsx: () => Promise<XlsxModule>;
  pdfParser: () => Promise<PdfParserModule>;
};

export type ParsedAttachment = {
  name: string;
  mimeType: string;
  text: string;
  sourceFormat: SourceFormat;
  sourceFingerprint: string;
  pdfInventory?: PdfInventory;
};

const MAX_FILES = 5;
const MAX_TEXT_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_FILE_SIZE_BYTES = 8 * 1024 * 1024;

const DYNAMIC_IMPORTS: DynamicImportLoaders = {
  mammoth: async () => (await import("mammoth")) as unknown as MammothModule,
  xlsx: async () => (await import("xlsx")) as unknown as XlsxModule,
  pdfParser: async () => (await import("pdf2json")) as unknown as PdfParserModule
};

export function __setDynamicImportOverridesForTests(overrides: Partial<DynamicImportLoaders>): void {
  Object.assign(DYNAMIC_IMPORTS, overrides);
}

function sanitizeExtractedText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function compactWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function getFileSizeLimitBytes(sourceFormat: SourceFormat): number {
  return isTextSourceFormat(sourceFormat) ? MAX_TEXT_FILE_SIZE_BYTES : MAX_BINARY_FILE_SIZE_BYTES;
}

async function parsePdfInventory(buffer: ArrayBuffer): Promise<PdfInventory> {
  const parserModule = await DYNAMIC_IMPORTS.pdfParser();
  const PdfParser = parserModule.default;
  const parser = new PdfParser();

  const pdfData = await new Promise<PdfData>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("PDF parser timed out; page count unknown")), 30_000);
    parser.on("pdfParser_dataError", (err) => {
      clearTimeout(timeout);
      reject(new Error(err?.parserError || "Unknown PDF parser error"));
    });
    parser.on("pdfParser_dataReady", (data) => {
      clearTimeout(timeout);
      resolve(data);
    });
    try { parser.parseBuffer(Buffer.from(buffer)); } catch (error) { clearTimeout(timeout); reject(error); }
  });

  if (!pdfData.Pages?.length) throw new Error("PDF page inventory unavailable");
  return inventoryPdf(pdfData.Pages);
}

export function validateFile(file: File): SourceFormat {
  const fileType = detectFileType(file);

  if (!fileType) {
    throw new Error(
      `Unsupported file type for "${file.name}". Supported extensions: ${supportedExtensionsForError()}.`
    );
  }

  const sizeLimitBytes = getFileSizeLimitBytes(fileType.sourceFormat);

  if (file.size > sizeLimitBytes) {
    const limitMb = Math.floor(sizeLimitBytes / (1024 * 1024));
    throw new Error(`File "${file.name}" is too large. Maximum file size for this type is ${limitMb}MB.`);
  }

  return fileType.sourceFormat;
}

export async function convertToPlainText(file: File): Promise<string> {
  const fileType = detectFileType(file);

  if (!fileType) {
    throw new Error(
      `Unsupported file type for "${file.name}". Supported extensions: ${supportedExtensionsForError()}.`
    );
  }

  if (fileType.sourceFormat === "text") {
    return sanitizeExtractedText(await file.text());
  }

  if (fileType.sourceFormat === "word") {
    try {
      const mammoth = await DYNAMIC_IMPORTS.mammoth();
      const buffer = Buffer.from(await file.arrayBuffer());
      const parsed = await mammoth.extractRawText({ buffer });
      return sanitizeExtractedText(compactWhitespace(parsed.value || ""));
    } catch {
      if (isLegacyWordType(fileType) || getFileExtension(file.name) === ".doc") {
        throw new Error(
          `Legacy .doc not supported for "${file.name}". Please convert the file to .docx and retry.`
        );
      }

      throw new Error(`Failed to parse Word document "${file.name}".`);
    }
  }

  if (fileType.sourceFormat === "excel") {
    try {
      const xlsx = await DYNAMIC_IMPORTS.xlsx();
      const workbook = xlsx.read(await file.arrayBuffer(), { type: "array" });
      const sheetChunks = workbook.SheetNames.map((sheetName) => {
        const worksheet = workbook.Sheets[sheetName] as Record<string, unknown>;
        const tsv = xlsx.utils.sheet_to_csv(worksheet, { FS: "\t" }).trimEnd();
        const formulas = Object.entries(worksheet).flatMap(([address, value]) => {
          if (address.startsWith("!") || !value || typeof value !== "object") return [];
          const cell = value as { f?: string; v?: unknown };
          return typeof cell.f === "string" ? [`${address}: =${cell.f}; cached value: ${JSON.stringify(cell.v) ?? "unavailable"}`] : [];
        });
        return `--- sheet: ${sheetName} ---\nUsed range: ${typeof worksheet["!ref"] === "string" ? worksheet["!ref"] : "not specified"}\n${tsv}${formulas.length ? `\nCell formulas:\n${formulas.join("\n")}` : ""}`;
      });
      return sanitizeExtractedText(sheetChunks.join("\n\n"));
    } catch {
      throw new Error(`Failed to parse Excel document "${file.name}".`);
    }
  }

  try {
    // Diagnostic log for production verification: uploads now use pdf2json, not pdfjs-dist/pdf-parse.
    console.info(`[uploads] parsing PDF with pdf2json: ${file.name}`);
    const rawBuffer = await file.arrayBuffer();
    const text = (await parsePdfInventory(rawBuffer)).pages.map(page => page.text).join("\n\n");
    return sanitizeExtractedText(compactWhitespace(text));
  } catch {
    throw new Error(`Failed to parse PDF document "${file.name}".`);
  }
}

export async function parseTextFiles(files: File[]): Promise<ParsedAttachment[]> {
  if (files.length > MAX_FILES) {
    throw new Error(`Too many files. Maximum allowed is ${MAX_FILES}.`);
  }

  return Promise.all(
    files.map(async (file) => {
      const sourceFormat = validateFile(file);
      const bytes = Buffer.from(await file.arrayBuffer());
      let pdfInventory: PdfInventory | undefined;
      if (sourceFormat === "pdf") {
        if (!bytes.subarray(0, 1024).toString("latin1").includes("%PDF-")) throw new Error(`Invalid PDF signature for "${file.name}".`);
        try { pdfInventory = await parsePdfInventory(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer); }
        catch (error) { throw new Error(`Failed to parse PDF document "${file.name}". ${error instanceof Error ? error.message.slice(0, 300) : "Page count and coverage unknown."}`); }
      }
      const text = pdfInventory ? pdfInventory.pages.map(page => page.text).join("\n\n") : await convertToPlainText(file);

      return {
        name: file.name,
        mimeType: sourceFormat === "pdf" ? "application/pdf" : file.type || ({".md":"text/markdown",".txt":"text/plain",".csv":"text/csv",".json":"application/json"} as Record<string,string>)[getFileExtension(file.name)] || detectFileType(file)?.mimeTypes[0] || "text/plain",
        sourceFingerprint: createHash("sha256").update(bytes).digest("hex"),
        pdfInventory,
        sourceFormat,
        text
      };
    })
  );
}
