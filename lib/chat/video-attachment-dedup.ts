import type { FileReference } from "@/lib/providers/types";
import type { ConversationAttachment } from "@/lib/chat/attachment-continuity";

type SelectedSource = { attachment: ConversationAttachment; mode: "summary" | "source" };
const isVideo = (file: Pick<FileReference, "mimeType">) => file.mimeType.startsWith("video/");
const compareVideos = /\b(compare|comparison|versus|vs\.?|differences?|both|earlier|previous|older|before\s+and\s+after)\b/i;
const normalizedName = (name: string) => name.normalize("NFC").trim().toLocaleLowerCase("en-US");

/**
 * An uploaded recording is authoritative for "review this video". The saved
 * attachment selector may return its older catalog entry too, often with
 * a different fileId. Don't supply two copies of a same-named video unless
 * the user explicitly requests a comparison with an older recording.
 *
 * Do not delete any saved entry. Preserve both when comparing recordings.
 */
export function pruneRepeatedVideoSelections(
  newlyUploaded: FileReference[],
  selections: SelectedSource[],
  message: string,
): SelectedSource[] {
  if (compareVideos.test(message)) return selections;
  const fresh = new Set(newlyUploaded.filter(isVideo)
    .map(file => `${file.mimeType.toLowerCase()}:${normalizedName(file.fileName)}`));
  const seenSavedVideos = new Set<string>();
  return selections.filter(({ attachment }) => {
    if (!isVideo(attachment)) return true;
    const key = `${attachment.mimeType.toLowerCase()}:${normalizedName(attachment.fileName)}`;
    // The assistant selector can return several catalog records for the same
    // saved screen recording even when there is no fresh upload. Keep the first
    // selected source; do not send multiple copies to Gemini/Grok.
    if (fresh.has(key) || seenSavedVideos.has(key)) return false;
    seenSavedVideos.add(key);
    return true;
  });
}

/** Deduplicate only strong identity matches, not separate similarly named videos. */
export function uniqueAttachmentReferences(files: FileReference[]): FileReference[] {
  const seenIds = new Set<string>();
  const seenProviderVideos = new Set<string>();
  return files.filter(file => {
    if (seenIds.has(file.fileId)) return false;
    const uri = isVideo(file) ? file.providerRef?.googleFileUri : undefined;
    if (uri && seenProviderVideos.has(uri)) return false;
    seenIds.add(file.fileId);
    if (uri) seenProviderVideos.add(uri);
    return true;
  });
}
