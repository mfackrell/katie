import { ChatGenerateParams } from "@/lib/providers/types";

const PREVIEW_TRUNCATION_NOTE = "[Preview-only attachment context. Full file body is intentionally excluded.]";
const EXTRACTED_TEXT_NOTE = "[Extracted attachment body available to the model.]";
const VIDEO_METADATA_NOTE = "[Video metadata only. Transcript/frame extraction is not currently available.]";

function normalizeForDeduplication(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatAttachmentContext(attachments: ChatGenerateParams["attachments"]): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }

  const seenBodies = new Set<string>();

  return attachments
    .map((attachment) => {
      const attachmentKind = attachment.attachmentKind ?? (attachment.mimeType.startsWith("video/") ? "video" : "file");
      const providerReferenceSummary = [
        attachment.providerRef?.openaiFileId
          ? `openaiFileId=${attachment.providerRef.openaiFileId}`
          : null,
        attachment.providerRef?.googleFileUri
          ? `googleFileUri=${attachment.providerRef.googleFileUri}`
          : null
      ]
        .filter((value): value is string => Boolean(value))
        .join(", ");

      const metadataLine = providerReferenceSummary
        ? ` (${providerReferenceSummary})`
        : "";
      const mediaSummary = `kind=${attachmentKind}; mime=${attachment.mimeType}; fileId=${attachment.fileId}`;
      const extractedText = attachment.extractedText?.trim();
      const normalizedBody = extractedText ? normalizeForDeduplication(extractedText) : "";
      const isDuplicateBody = Boolean(normalizedBody) && seenBodies.has(normalizedBody);

      if (normalizedBody) {
        seenBodies.add(normalizedBody);
      }

      const shouldUseExtractedText = attachmentKind !== "video" && Boolean(extractedText) && !isDuplicateBody;
      const contextHeader = attachmentKind === "video"
        ? VIDEO_METADATA_NOTE
        : shouldUseExtractedText
          ? EXTRACTED_TEXT_NOTE
          : PREVIEW_TRUNCATION_NOTE;
      const contextBody = shouldUseExtractedText
        ? extractedText
        : isDuplicateBody
          ? `[Duplicate extracted text omitted to reduce repeated context. Preview follows.]\n${attachment.preview}`
          : attachment.preview;
      const endMarker = shouldUseExtractedText ? "### END OF EXTRACTED FILE BODY ###" : "### END OF FILE PREVIEW ###";

      return [
        `### ATTACHED FILE: ${attachment.fileName}${metadataLine} ###`,
        mediaSummary,
        contextHeader,
        contextBody,
        endMarker
      ].join("\n");
    })
    .join("\n\n");
}
