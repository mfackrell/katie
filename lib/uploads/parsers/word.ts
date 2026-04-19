import { buildPreview, compactWhitespace, sanitizeExtractedText, type IngestionContext, type IngestedFile } from "@/lib/uploads/parsers/shared";

type MammothModule = {
  extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
};

export type WordParserDeps = {
  mammoth: () => Promise<MammothModule>;
};

const DEFAULT_DEPS: WordParserDeps = {
  mammoth: async () => (await import("mammoth")) as unknown as MammothModule
};

let DEPS = DEFAULT_DEPS;

export function __setWordParserDepsForTests(overrides: Partial<WordParserDeps>): void {
  DEPS = { ...DEPS, ...overrides };
}

export async function parseWord(context: IngestionContext): Promise<IngestedFile> {
  if (context.extension === ".doc") {
    throw new Error(`Legacy .doc not supported for "${context.file.name}". Please convert the file to .docx and retry.`);
  }

  try {
    const mammoth = await DEPS.mammoth();
    const parsed = await mammoth.extractRawText({ arrayBuffer: await context.file.arrayBuffer() });
    const extractedText = sanitizeExtractedText(compactWhitespace(parsed.value || ""));

    return {
      fileName: context.file.name,
      mimeType: context.mimeType,
      sourceFormat: "word",
      attachmentKind: "text",
      extractedText,
      preview: buildPreview(extractedText),
      ingestionQuality: extractedText.length > 0 ? "high" : "low",
      parseWarnings: extractedText.length > 0 ? undefined : ["No extractable text found in Word document."]
    };
  } catch {
    throw new Error(`Failed to parse Word document "${context.file.name}".`);
  }
}
