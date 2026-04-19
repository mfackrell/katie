import { buildPreview, sanitizeExtractedText, stripMarkupToText, type IngestionContext, type IngestedFile } from "@/lib/uploads/parsers/shared";

function parseJson(text: string): { extractedText: string; preview: string; structuredData?: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(text) as unknown;
    const pretty = JSON.stringify(parsed, null, 2);
    return {
      extractedText: sanitizeExtractedText(pretty),
      preview: buildPreview(pretty),
      structuredData: typeof parsed === "object" && parsed !== null ? { json: parsed as Record<string, unknown> } : undefined
    };
  } catch {
    const normalized = sanitizeExtractedText(text);
    return { extractedText: normalized, preview: buildPreview(normalized) };
  }
}

export async function parseTextLike(context: IngestionContext): Promise<IngestedFile> {
  const raw = await context.file.text();
  const base = {
    fileName: context.file.name,
    mimeType: context.mimeType,
    attachmentKind: "text" as const,
    ingestionQuality: "high" as const
  };

  if (context.extension === ".json" || context.mimeType === "application/json") {
    const result = parseJson(raw);
    return { ...base, sourceFormat: "json", ...result };
  }

  if ([".html", ".htm"].includes(context.extension) || context.mimeType.includes("html")) {
    const extractedText = sanitizeExtractedText(stripMarkupToText(raw));
    return {
      ...base,
      sourceFormat: "html",
      extractedText,
      preview: buildPreview(extractedText)
    };
  }

  if (context.extension === ".xml" || context.mimeType.includes("xml")) {
    const extractedText = sanitizeExtractedText(stripMarkupToText(raw));
    return {
      ...base,
      sourceFormat: "xml",
      extractedText,
      preview: buildPreview(extractedText)
    };
  }

  const extractedText = sanitizeExtractedText(raw);
  return {
    ...base,
    sourceFormat: "text",
    extractedText,
    preview: buildPreview(extractedText)
  };
}
