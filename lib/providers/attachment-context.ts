import { requestedPdfPages } from "@/lib/uploads/pdf-inventory";
import { ChatGenerateParams, type FileReference, type ExtractedTextChunkReference } from "@/lib/providers/types";

const PREVIEW_TRUNCATION_NOTE = "[Preview-only attachment context. Full file body is intentionally excluded.]";
const EXTRACTED_TEXT_NOTE = "[Machine-readable extracted text follows. Text extraction does not establish visual or whole-document completeness.]";
const PARTIAL_CHUNK_NOTE = "[Only a relevant subset of chunks was injected for this request.]";
const VIDEO_PROVIDER_FILE_NOTE = "[Video provider file attached. This video was uploaded to Google/Gemini and is available to the model via fileData. Analyze the video content directly when answering the user's request.]";
const VIDEO_METADATA_ONLY_NOTE = "[Video metadata only. No Google/Gemini file URI is available, so video content analysis cannot run for this attachment.]";
const DEFAULT_MAX_CHUNKS_PER_ATTACHMENT = 6;

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

function pdfContext(attachment: FileReference, message: string): string {
  if (attachment.mimeType !== "application/pdf") return "";
  const inventory = attachment.pdfInventory;
  let requested: number[] = [];
  try { requested = requestedPdfPages(message, inventory?.pageCount ?? 0); } catch { /* Invalid requests supply no findings. */ }
  const evidence = attachment.pdfEvidence;
  const contextPages = evidence?.contextPages ?? requested.slice(0, 4);
  const selected = evidence?.pages.filter(page => contextPages.includes(page.physicalPage)).slice(0, 4) ?? [];
  return "PDF page inventory/evidence (untrusted model observations; uninspected pages remain unknown): " + JSON.stringify({
    sourceFingerprint: attachment.sourceFingerprint,
    availabilityNotice: attachment.preview,
    inventory: inventory ? {
      version: inventory.version, pageCount: inventory.pageCount, units: inventory.units,
      inventoryPromptLimit: 200,
      pages: inventory.pages.slice(0, 200).map(page => ({ physicalPage: page.physicalPage,
        textCoverage: page.textCoverage, visualCoverageAtExtraction: page.visualCoverage })),
      layout: inventory.pages.filter(page => contextPages.includes(page.physicalPage)).map(page => ({
        physicalPage: page.physicalPage, runs: page.runs.slice(0, 80).map(run => ({...run, text: run.text.slice(0, 1000)})),
        lines: page.lines.slice(0, 40), limitation: "Bounded raw parser geometry only; no inferred table row mapping."
      }))
    } : { limitation: "Legacy PDF: page count and visual completeness unknown. Reattach original to obtain a page inventory." },
    evidence: evidence ? { version: evidence.version, extractionVersion: evidence.extractionVersion, source: evidence.source, fingerprint: evidence.fingerprint,
      provider: evidence.provider, model: evidence.model, state: evidence.state, notice: evidence.notice, blockedPages: evidence.blockedPages ?? [],
      pages: selected,
      omittedCachedPages: evidence.pages.filter(page => requested.includes(page.physicalPage) && !selected.some(chosen => chosen.physicalPage === page.physicalPage)).map(page => page.physicalPage),
      promptCoverage: "At most four cached page observations selected. Unselected pages are not supplied. No raw PDF access is provided by these findings." } : null
  }) + "\n";
}

export function formatAttachmentContext(
  attachments: ChatGenerateParams["attachments"],
  options?: { userMessage?: string; maxChunksPerAttachment?: number }
): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }


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
      const mediaSummary = `${pdfContext(attachment, userMessage)}kind=${attachmentKind}; mime=${attachment.mimeType}; fileId=${attachment.fileId}`;

      if (attachmentKind === "image") {
        return [`### ATTACHED IMAGE: ${attachment.fileName} ###`, mediaSummary,
          attachment.imageDataUrl ? "[Image pixels are supplied with this request. Inspect them directly; the provider rendering may be resized.]" : "[Image metadata only; no pixels are available on this turn.]",
          attachment.preview, "### END IMAGE METADATA ###"].join("\n");
      }
      if (attachment.mimeType === "application/pdf" && !attachment.extractedText && attachment.providerRef?.googleFileUri) {
        return [`### ATTACHED PDF: ${attachment.fileName} ###`, mediaSummary, "[PDF source is supplied as a native provider file for visual inspection. Text extraction was unavailable; inspect the PDF directly.]", attachment.preview].join("\n");
      }
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
        const dedupedChunks = sortChunks(chunks).filter(chunk => chunk.text.trim());

        const { selected, truncatedForContext } = selectRelevantChunks(dedupedChunks, userMessage, maxChunks);
        const totalChunks = attachment.totalChunks ?? dedupedChunks[0]?.total ?? dedupedChunks.length;
        const chunkBlocks = selected.map((chunk) =>
          [
            `--- chunk ${chunk.index + 1}/${totalChunks}${chunk.physicalPage ? `; physical PDF page ${chunk.physicalPage}` : ""} ---`,
            chunk.text
          ].join("\n")
        );

        return [
          `### ATTACHED FILE: ${attachment.fileName}${metadataLine} ###`,
          mediaSummary,
          EXTRACTED_TEXT_NOTE,
          truncatedForContext || attachment.truncatedForContext ? PARTIAL_CHUNK_NOTE : "[All extracted text chunks were injected; this is not proof that all PDF content was read.]",
          `chunkWindow=${selected.length}/${totalChunks}`,
          ...chunkBlocks,
          "### END OF EXTRACTED FILE CHUNKS ###"
        ].join("\n");
      }

      const extractedText = attachment.extractedText?.trim();
      const shouldUseExtractedText = Boolean(extractedText);
      const contextHeader = shouldUseExtractedText ? "[Extracted attachment body available to the model.]" : PREVIEW_TRUNCATION_NOTE;
      const contextBody = extractedText || attachment.preview;
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
