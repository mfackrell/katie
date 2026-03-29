import { ChatGenerateParams } from "@/lib/providers/types";

const PREVIEW_TRUNCATION_NOTE = "[Preview-only attachment context. Full file body is intentionally excluded.]";

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
      const previewHeader = attachmentKind === "video"
        ? "[Video metadata only. Transcript/frame extraction is not currently available.]"
        : PREVIEW_TRUNCATION_NOTE;

      return [
        `### ATTACHED FILE: ${attachment.fileName}${metadataLine} ###`,
        mediaSummary,
        previewHeader,
        attachment.preview,
        "### END OF FILE PREVIEW ###"
      ].join("\n");
    })
    .join("\n\n");
}
