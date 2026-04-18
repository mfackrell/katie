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

type PdfParseResult = {
  items: Array<{ str?: string }>;
};

type PdfPage = {
  getTextContent(): Promise<PdfParseResult>;
};

type PdfDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
};

type PdfjsModule = {
  getDocument(input: {
    data: Uint8Array;
    disableWorker?: boolean;
    useSystemFonts?: boolean;
    isEvalSupported?: boolean;
    stopAtErrors?: boolean;
  }): {
    promise: Promise<PdfDocument>;
  };
  GlobalWorkerOptions?: {
    workerSrc?: string;
  };
};

type DynamicImportLoaders = {
  mammoth: () => Promise<MammothModule>;
  xlsx: () => Promise<XlsxModule>;
  pdfjs: () => Promise<PdfjsModule>;
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
const MAX_OUTPUT_CHARS = 50_000;
const MAX_EXCEL_SHEETS = 20;

const DYNAMIC_IMPORTS: DynamicImportLoaders = {
  mammoth: async () => (await import("mammoth")) as unknown as MammothModule,
  xlsx: async () => (await import("xlsx")) as unknown as XlsxModule,
  pdfjs: async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule
};

export function __setDynamicImportOverridesForTests(overrides: Partial<DynamicImportLoaders>): void {
  Object.assign(DYNAMIC_IMPORTS, overrides);
}

function sanitizeExtractedText(text: string): string {
  const withoutControlChars = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (withoutControlChars.length <= MAX_OUTPUT_CHARS) {
    return withoutControlChars;
  }

  return `${withoutControlChars.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
}

function compactWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function ensureNonEmptyExtraction(text: string, fileName: string, formatLabel: string): string {
  const normalized = compactWhitespace(text);
  if (normalized.length > 0) {
    return normalized;
  }

  return `[No extractable ${formatLabel} text found in \"${fileName}\". The document may be scanned/image-based or encrypted.]`;
}

function getFileSizeLimitBytes(sourceFormat: SourceFormat): number {
  return isTextSourceFormat(sourceFormat) ? MAX_TEXT_FILE_SIZE_BYTES : MAX_BINARY_FILE_SIZE_BYTES;
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
    const pdfjs = await DYNAMIC_IMPORTS.pdfjs();
    const rawBytes = new Uint8Array(await file.arrayBuffer());
    const workerUrl = new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString();
    if (pdfjs.GlobalWorkerOptions) {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    }

    const runExtraction = async (options: {
      disableWorker?: boolean;
      useSystemFonts: boolean;
      isEvalSupported: boolean;
      stopAtErrors: boolean;
    }) => {
      const loadingTask = pdfjs.getDocument({
        data: rawBytes,
        disableWorker: options.disableWorker,
        useSystemFonts: options.useSystemFonts,
        isEvalSupported: options.isEvalSupported,
        stopAtErrors: options.stopAtErrors
      });
      const pdfDocument = await loadingTask.promise;
      const pageTextChunks: string[] = [];

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => item.str ?? "")
          .join(" ")
          .trim();
        pageTextChunks.push(text);
      }

      return pageTextChunks.join("\n\n");
    };

    let extracted = "";
    try {
      extracted = await runExtraction({
        useSystemFonts: true,
        isEvalSupported: false,
        stopAtErrors: false,
      });
    } catch (primaryError) {
      const message = primaryError instanceof Error ? primaryError.message : String(primaryError);
      if (!message.includes("Setting up fake worker failed")) {
        throw primaryError;
      }

      extracted = await runExtraction({
        disableWorker: true,
        useSystemFonts: true,
        isEvalSupported: false,
        stopAtErrors: false,
      });
    }

    return sanitizeExtractedText(ensureNonEmptyExtraction(extracted, file.name, "PDF"));
  } catch (error) {
    const reason = error instanceof Error && error.message.trim().length > 0 ? ` Reason: ${error.message}` : "";
    throw new Error(`Failed to parse PDF document "${file.name}".${reason}`);
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
