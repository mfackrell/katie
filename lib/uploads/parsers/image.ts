import { type IngestionContext, type IngestedFile } from "@/lib/uploads/parsers/shared";

export function parseImage(context: IngestionContext): IngestedFile {
  return {
    fileName: context.file.name,
    mimeType: context.mimeType,
    sourceFormat: "image",
    attachmentKind: "image",
    preview: `[Image attachment: ${context.file.name}; MIME: ${context.mimeType}; Size: ${context.file.size} bytes.]`,
    ingestionQuality: "high"
  };
}
