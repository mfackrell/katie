import { ChatGenerateParams, type ExtractedTextChunkReference } from "@/lib/providers/types";

const PREVIEW_TRUNCATION_NOTE = "[Preview-only attachment context. Full file body is intentionally excluded.]";
const EXTRACTED_TEXT_NOTE = "[Full extracted document is available in ordered chunks.]";
const PARTIAL_CHUNK_NOTE = "[Only a relevant subset of chunks was injected for this request.]";
const VIDEO_PROVIDER_FILE_NOTE = "[Video provider file attached. This video was uploaded to Google/Gemini and is available to the model via fileData. Analyze the video content directly when answering the user's request.]";
const VIDEO_METADATA_ONLY_NOTE = "[Video metadata only. No Google/Gemini file URI is available, so video content analysis cannot run for this attachment.]";
const DEFAULT_MAX_CHUNKS_PER_ATTACHMENT = 6;

function normalizeForDeduplication(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function sortChunks(chunks: ExtractedTextChunkReference[]): ExtractedTextChunkReference[] {
  return [...chunks].sort((a, b) => a.index - b.index);
}

function selectRelevantChunks(
  chunks: ExtractedTextChunkReference[],
  userMessage: string,
  maxChunks: number
): { selected: ExtractedTextChunkReference[]; truncatedForContext: boolean } {
  const ordered = sortChunks(chunks);
  if (ordered.length <= maxChunks) {
    return { selected: ordered, truncatedForContext: false };
  }

  const queryTokens = tokenizeQuery(userMessage);
  if (queryTokens.length === 0) {
    return { selected: ordered.slice(0, maxChunks), truncatedForContext: true };
  }

  const scored = ordered
    .map((chunk) => {
      const normalizedChunk = chunk.text.toLowerCase();
      const score = queryTokens.reduce((acc, token) => acc + (normalizedChunk.includes(token) ? 1 : 0), 0);
      return { chunk, score };
    })
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.chunk.index - b.chunk.index));

  const selected = scored
    .slice(0, maxChunks)
    .map((entry) => entry.chunk)
    .sort((a, b) => a.index - b.index);

  return { selected, truncatedForContext: true };
}

export function formatAttachmentContext(
  attachments: ChatGenerateParams["attachments"],
  options?: { userMessage?: string; maxChunksPerAttachment?: number }
): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }

  const seenBodies = new Set<string>();
  const userMessage = options?.userMessage ?? "";
  const maxChunks = options?.maxChunksPerAttachment ?? DEFAULT_MAX_CHUNKS_PER_ATTACHMENT;

  return attachments
    .map((attachment) => {
      const attachmentKind = attachment.attachmentKind ?? (attachment.mimeType.startsWith("video/") ? "video" : "file");
      const providerReferenceSummary = [
        attachment.providerRef?.openaiFileId ? `openaiFileId=${attachment.providerRef.openaiFileId}` : null,
        attachment.providerRef?.googleFileUri ? `googleFileUri=${attachment.providerRef.googleFileUri}` : null
      ]
        .filter((value): value is string => Boolean(value))
        .join(", ");

      const metadataLine = providerReferenceSummary ? ` (${providerReferenceSummary})` : "";
      const mediaSummary = `kind=${attachmentKind}; mime=${attachment.mimeType}; fileId=${attachment.fileId}`;

      if (attachmentKind === "video") {
        return [
          `### ATTACHED FILE: ${attachment.fileName}${metadataLine} ###`,
          mediaSummary,
          attachment.providerRef?.googleFileUri ? VIDEO_PROVIDER_FILE_NOTE : VIDEO_METADATA_ONLY_NOTE,
          attachment.preview,
          "### END OF FILE PREVIEW ###"
        ].join("\n");
      }

      const chunks = attachment.extractedChunks ?? [];
      if (chunks.length > 0) {
        const dedupedChunks = sortChunks(chunks).filter((chunk) => {
          const normalizedBody = normalizeForDeduplication(chunk.text);
          if (!normalizedBody || seenBodies.has(normalizedBody)) {
            return false;
          }
          seenBodies.add(normalizedBody);
          return true;
        });

        const { selected, truncatedForContext } = selectRelevantChunks(dedupedChunks, userMessage, maxChunks);
        const totalChunks = attachment.totalChunks ?? dedupedChunks[0]?.total ?? dedupedChunks.length;
        const chunkBlocks = selected.map((chunk) =>
          [
            `--- chunk ${chunk.index + 1}/${totalChunks} ---`,
            chunk.text
          ].join("\n")
        );

        return [
          `### ATTACHED FILE: ${attachment.fileName}${metadataLine} ###`,
          mediaSummary,
          EXTRACTED_TEXT_NOTE,
          truncatedForContext || attachment.truncatedForContext ? PARTIAL_CHUNK_NOTE : "[All chunks were injected for this request.]",
          `chunkWindow=${selected.length}/${totalChunks}`,
          ...chunkBlocks,
          "### END OF EXTRACTED FILE CHUNKS ###"
        ].join("\n");
      }

      const extractedText = attachment.extractedText?.trim();
      const normalizedBody = extractedText ? normalizeForDeduplication(extractedText) : "";
      const isDuplicateBody = Boolean(normalizedBody) && seenBodies.has(normalizedBody);

      if (normalizedBody) {
        seenBodies.add(normalizedBody);
      }

      const shouldUseExtractedText = Boolean(extractedText) && !isDuplicateBody;
      const contextHeader = shouldUseExtractedText ? "[Extracted attachment body available to the model.]" : PREVIEW_TRUNCATION_NOTE;
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
