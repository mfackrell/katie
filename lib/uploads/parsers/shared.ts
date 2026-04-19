export type IngestionQuality = "high" | "medium" | "low" | "failed";

export type IngestedFile = {
  fileName: string;
  mimeType: string;
  sourceFormat:
    | "pdf"
    | "word"
    | "excel"
    | "powerpoint"
    | "text"
    | "image"
    | "email"
    | "html"
    | "xml"
    | "json"
    | "unknown";
  attachmentKind: "text" | "image" | "video" | "file";
  extractedText?: string;
  structuredData?: Record<string, unknown>;
  preview: string;
  parseWarnings?: string[];
  ingestionQuality: IngestionQuality;
};

export type IngestionContext = {
  file: File;
  extension: string;
  mimeType: string;
};

export const MAX_OUTPUT_CHARS = 50_000;
export const PREVIEW_MAX_CHARS = 2_000;

export function sanitizeExtractedText(text: string): string {
  const withoutControlChars = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (withoutControlChars.length <= MAX_OUTPUT_CHARS) {
    return withoutControlChars;
  }

  return `${withoutControlChars.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
}

export function compactWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildPreview(text: string): string {
  const normalized = compactWhitespace(text);
  if (normalized.length <= PREVIEW_MAX_CHARS) {
    return normalized || "[No preview available]";
  }

  return `${normalized.slice(0, PREVIEW_MAX_CHARS)}…`;
}

export function ensureNonEmptyText(text: string, fallback: string): string {
  const normalized = compactWhitespace(text);
  return normalized.length > 0 ? normalized : fallback;
}

export function stripMarkupToText(input: string): string {
  return compactWhitespace(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
  );
}
