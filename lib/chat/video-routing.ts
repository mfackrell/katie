import { LlmProvider } from "@/lib/providers/types";

type FileReference = {
  fileId: string;
  fileName: string;
  mimeType: string;
  preview: string;
  attachmentKind?: "image" | "video" | "text" | "file";
  providerRef?: {
    openaiFileId?: string;
    googleFileUri?: string;
  };
};

export type AttachmentSupportCheck = { supported: true } | { supported: false; reason: string };
const GOOGLE_VIDEO_ROUTING_DEFAULT_MODEL = "gemini-3.1-pro";

export type VideoRoutingPolicy =
  | { mode: "normal" }
  | { mode: "force-google" }
  | { mode: "manual-google" }
  | { mode: "reject-override"; provider: string };

export function isVideoAttachment(attachment: FileReference): boolean {
  return attachment.attachmentKind === "video" || attachment.mimeType.startsWith("video/");
}

export function resolveVideoRoutingPolicy(hasVideoInput: boolean, overrideProvider?: string): VideoRoutingPolicy {
  if (!hasVideoInput) {
    return { mode: "normal" };
  }

  if (!overrideProvider) {
    return { mode: "force-google" };
  }

  if (overrideProvider !== "google") {
    return { mode: "reject-override", provider: overrideProvider };
  }

  return { mode: "manual-google" };
}

export function getAttachmentSupportForProvider(
  providerName: LlmProvider["name"],
  attachments: FileReference[] | undefined
): AttachmentSupportCheck {
  if (!attachments?.length) {
    return { supported: true };
  }

  const videoAttachments = attachments.filter(isVideoAttachment);
  if (videoAttachments.length === 0) {
    return { supported: true };
  }

  if (providerName === "google") {
    const missingRef = videoAttachments.find((attachment) => !attachment.providerRef?.googleFileUri);
    if (missingRef) {
      return {
        supported: false,
        reason: `Google video ingestion requires uploaded file references. Missing Google file URI for \"${missingRef.fileName}\".`
      };
    }
    return { supported: true };
  }

  return {
    supported: false,
    reason: `Provider \"${providerName}\" does not currently support video attachments in this chat flow.`
  };
}

export async function selectGoogleModelForVideoRouting(provider: LlmProvider, overrideModel?: string): Promise<string> {
  const availableModels = await provider.listModels();
  if (!availableModels.length) {
    throw new Error("Google provider has no available models for video routing.");
  }

  if (overrideModel) {
    if (!availableModels.includes(overrideModel)) {
      throw new Error(`Unknown override model for provider google: ${overrideModel}`);
    }
    return overrideModel;
  }

  if (availableModels.includes(GOOGLE_VIDEO_ROUTING_DEFAULT_MODEL)) {
    return GOOGLE_VIDEO_ROUTING_DEFAULT_MODEL;
  }

  return availableModels[0];
}
