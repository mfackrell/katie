import type { ChatGenerateParams, LlmProvider } from "@/lib/providers/types";

const FILE_ANALYSIS_PATTERNS = [
  /\banaly[sz]e\b/i,
  /\breview\b/i,
  /\baudit\b/i,
  /\bsummar(?:ize|ise)\b/i,
  /\bextract\b/i,
  /\bwalk\s+through\b/i
];

export function shouldRunChunkedWorkflow(userMessage: string, attachments: ChatGenerateParams["attachments"]): boolean {
  if (!attachments?.some((attachment) => !attachment.pdfInventory && (attachment.extractedChunks?.length ?? 0) > 1)) {
    return false;
  }

  return FILE_ANALYSIS_PATTERNS.some((pattern) => pattern.test(userMessage));
}

export async function analyzeChunkedAttachments(params: {
  provider: LlmProvider;
  modelId: string;
  name: string;
  persona: string;
  summary: string;
  userMessage: string;
  attachments: ChatGenerateParams["attachments"];
}): Promise<string> {
  const { provider, modelId, name, persona, summary, userMessage } = params;
  const attachments = params.attachments ?? [];

  const notes: string[] = [];
  for (const attachment of attachments) {
    // Inventoried PDFs use bounded page-linked context and reusable visual evidence.
    if (attachment.pdfInventory) continue;
    const chunks = (attachment.extractedChunks ?? []).slice().sort((a, b) => a.index - b.index);
    if (chunks.length === 0) {
      continue;
    }

    const chunkFindings: string[] = [];
    for (const chunk of chunks) {
      const result = await provider.generate({
        name,
        persona,
        summary,
        history: [],
        user: [
          `User request: ${userMessage}`,
          `Analyze file chunk ${chunk.index + 1}/${chunks.length} from ${attachment.fileName} (${attachment.mimeType}), source ${attachment.fileId}${chunk.physicalPage ? `, physical PDF page ${chunk.physicalPage}` : ""}.`,
          "This is extracted text only, not complete visual evidence. Do not infer financial row associations from flattened columns.",
          "Return concise factual findings with any numeric values preserved.",
          `Chunk body:\n${chunk.text}`
        ].join("\n\n"),
        requestIntent: "general-text",
        modelId,
        attachments: []
      });
      chunkFindings.push(`chunk ${chunk.index + 1}/${chunks.length}: ${result.text.trim()}`);
    }

    notes.push(
      [
        `File ${attachment.fileName} (source ${attachment.fileId}) analyzed across ${chunks.length}/${chunks.length} chunks. Extracted text only; no claim of whole PDF coverage.`,
        ...chunkFindings
      ].join("\n")
    );
  }

  if (notes.length === 0) {
    return "";
  }

  return [
    "[Server chunk-by-chunk analysis prepass]",
    "This summary was generated across ordered chunks before final answer synthesis.",
    ...notes
  ].join("\n\n");
}
