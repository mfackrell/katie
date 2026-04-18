import { ChatGenerateParams } from "@/lib/providers/types";

const PREVIEW_TRUNCATION_NOTE = "[Attachment context is a truncated preview because extraction was unavailable.]";

export function formatAttachmentContext(attachments: ChatGenerateParams["attachments"]): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }

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
      const body = attachment.extractedText?.trim() || attachment.preview;
      const previewHeader = attachmentKind === "video"
        ? "[Video metadata only. Transcript/frame extraction is not currently available.]"
        : attachment.extractedText
          ? "[Extracted attachment content]"
          : PREVIEW_TRUNCATION_NOTE;

      return [
        `### ATTACHED FILE: ${attachment.fileName}${metadataLine} ###`,
        mediaSummary,
        previewHeader,
        body,
        "### END OF FILE PREVIEW ###"
      ].join("\n");
    })
    .join("\n\n");
}
