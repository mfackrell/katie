import { ChatGenerateParams } from "@/lib/providers/types";

export function formatAttachmentContext(attachments: ChatGenerateParams["attachments"]): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }

  return attachments
    .map(
      (attachment) =>
        `### ATTACHED FILE: ${attachment.name} ###\n${attachment.text}\n### END OF FILE ###`
    )
    .join("\n\n");
}

