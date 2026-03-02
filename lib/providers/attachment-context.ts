import { ChatGenerateParams } from "@/lib/providers/types";

const PREVIEW_TRUNCATION_NOTE = "[Preview-only attachment context. Full file body is intentionally excluded.]";

export function formatAttachmentContext(attachments: ChatGenerateParams["attachments"]): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }

  return attachments
    .map((attachment) => {
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

      return [
        `### ATTACHED FILE: ${attachment.fileName}${metadataLine} ###`,
        PREVIEW_TRUNCATION_NOTE,
        attachment.preview,
        "### END OF FILE PREVIEW ###"
      ].join("\n");
    })
    .join("\n\n");
}
