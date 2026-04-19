import {
  buildPreview,
  compactWhitespace,
  ensureNonEmptyText,
  sanitizeExtractedText,
  type IngestionContext,
  type IngestedFile
} from "@/lib/uploads/parsers/shared";

type PdfPage = {
  getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
};

type PdfDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
};

type PdfjsModule = {
  getDocument(input: {
    data: Uint8Array;
    disableWorker: boolean;
    useSystemFonts?: boolean;
    isEvalSupported?: boolean;
    stopAtErrors?: boolean;
  }): {
    promise: Promise<PdfDocument>;
  };
};

export type PdfParserDeps = {
  pdfjs: () => Promise<PdfjsModule>;
};

const DEFAULT_DEPS: PdfParserDeps = {
  pdfjs: async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule
};

let DEPS = DEFAULT_DEPS;

export function __setPdfParserDepsForTests(overrides: Partial<PdfParserDeps>): void {
  DEPS = { ...DEPS, ...overrides };
}

export async function parsePdf(context: IngestionContext): Promise<IngestedFile> {
  try {
    const pdfjs = await DEPS.pdfjs();
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(await context.file.arrayBuffer()),
      disableWorker: true,
      useSystemFonts: true,
      isEvalSupported: false,
      stopAtErrors: false
    });

    const doc = await loadingTask.promise;
    const chunks: string[] = [];

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = compactWhitespace(content.items.map((item) => item.str ?? "").join(" "));
      chunks.push(`--- page ${pageNumber} ---\n${text}`);
    }

    const joined = sanitizeExtractedText(chunks.join("\n\n"));
    const effective = ensureNonEmptyText(joined, "");
    const looksEmpty = effective.replace(/[-\s\n]|page\s+\d+/gi, "").trim().length < 20;

    if (looksEmpty) {
      return {
        fileName: context.file.name,
        mimeType: context.mimeType,
        sourceFormat: "pdf",
        attachmentKind: "text",
        extractedText: "",
        preview: "[PDF appears scanned/image-based; text extraction produced little to no usable text.]",
        parseWarnings: [
          "PDF text extraction was poor. This appears to be scanned/image-based and OCR fallback is not available in this environment."
        ],
        ingestionQuality: "low"
      };
    }

    return {
      fileName: context.file.name,
      mimeType: context.mimeType,
      sourceFormat: "pdf",
      attachmentKind: "text",
      extractedText: joined,
      preview: buildPreview(joined),
      ingestionQuality: "high"
    };
  } catch (error) {
    const reason = error instanceof Error && error.message.trim().length > 0 ? ` Reason: ${error.message}` : "";
    throw new Error(`Failed to parse PDF document "${context.file.name}".${reason}`);
  }
}
