import {
  detectFileType,
  getFileExtension,
  isLegacyWordType,
  isTextSourceFormat,
  supportedExtensionsForError,
  type SourceFormat
} from "@/lib/uploads/file-type-helpers";

type MammothModule = {
  extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
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
  R?: PdfTextSegment[];
};

type PdfPage = {
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
};

const MAX_FILES = 5;
const MAX_TEXT_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const MAX_EXCEL_SHEETS = 20;

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

function extractTextFromPdfData(pdfData: PdfData): string {
  const pages = pdfData.Pages ?? [];
  const lines: string[] = [];

  for (const page of pages) {
    const textRuns = page.Texts ?? [];
    const pageText = textRuns
      .map((run) =>
        (run.R ?? [])
          .map((segment) => {
            if (!segment.T) {
              return "";
            }
            try {
              return decodeURIComponent(segment.T);
            } catch {
              return segment.T;
            }
          })
          .join("")
      )
      .join("\n");
    lines.push(pageText);
  }

  return lines.join("\n\n");
}

async function parsePdfToText(buffer: ArrayBuffer): Promise<string> {
  const parserModule = await DYNAMIC_IMPORTS.pdfParser();
  const PdfParser = parserModule.default;
  const parser = new PdfParser();

  const pdfData = await new Promise<PdfData>((resolve, reject) => {
    parser.on("pdfParser_dataError", (err) => {
      reject(new Error(err?.parserError || "Unknown PDF parser error"));
    });
    parser.on("pdfParser_dataReady", (data) => {
      resolve(data);
    });
    parser.parseBuffer(Buffer.from(buffer));
  });

  return extractTextFromPdfData(pdfData);
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
      const buffer = await file.arrayBuffer();
      const parsed = await mammoth.extractRawText({ arrayBuffer: buffer });
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
      const sheetChunks = workbook.SheetNames.slice(0, MAX_EXCEL_SHEETS).map((sheetName) => {
        const worksheet = workbook.Sheets[sheetName];
        const tsv = xlsx.utils.sheet_to_csv(worksheet, { FS: "\t" }).trim();
        return `--- sheet: ${sheetName} ---\n${tsv}`;
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
    const text = await parsePdfToText(rawBuffer);
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
      const text = await convertToPlainText(file);

      return {
        name: file.name,
        mimeType: file.type || "text/plain",
        sourceFormat,
        text
      };
    })
  );
}
