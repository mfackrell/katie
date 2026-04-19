import { ingestFile, validateFileForIngestion } from "@/lib/uploads/ingest-file";
import { type SourceFormat } from "@/lib/uploads/file-type-helpers";

export type ParsedAttachment = {
  name: string;
  mimeType: string;
  text: string;
  sourceFormat: SourceFormat;
};

const MAX_FILES = 5;

export function __setDynamicImportOverridesForTests(): void {
  // Kept for backward compatibility with older tests; parser-level overrides now live in parser modules.
}

export function validateFile(file: File): SourceFormat {
  const detected = validateFileForIngestion(file);
  if (!detected) {
    throw new Error(`Unsupported file type for "${file.name}".`);
  }
  return detected.sourceFormat;
}

export async function convertToPlainText(file: File): Promise<string> {
  const ingested = await ingestFile(file);
  if (ingested.attachmentKind === "image") {
    throw new Error(`Image file "${file.name}" is attachable but not convertible to plain text.`);
  }

  return ingested.extractedText ?? ingested.preview;
}

export async function parseTextFiles(files: File[]): Promise<ParsedAttachment[]> {
  if (files.length > MAX_FILES) {
    throw new Error(`Too many files. Maximum allowed is ${MAX_FILES}.`);
  }

  const parsed = await Promise.all(files.map((file) => ingestFile(file)));

  return parsed
    .filter((item) => item.attachmentKind !== "image")
    .map((item) => ({
      name: item.fileName,
      mimeType: item.mimeType,
      sourceFormat: item.sourceFormat === "json" || item.sourceFormat === "html" || item.sourceFormat === "xml"
        ? "text"
        : (item.sourceFormat as SourceFormat),
      text: item.extractedText ?? item.preview
    }));
}
