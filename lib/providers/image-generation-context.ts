import type { ChatGenerateParams } from "./types";

/**
 * Image generation needs identity, recent visual direction and the actual source
 * images, not a copy of the whole chat/project corpus in its system instruction.
 * This bounds *derived background only*. Current user input, image bytes,
 * attachments, identity references, and provider/billing metadata are unchanged.
 */
const OMITTED = "\n[Older background omitted for this image request.]\n";

function boundedBackground(source: string, head: number, tail: number): string {
  if (source.length <= head + tail) return source;
  return source.slice(0, head) + OMITTED + source.slice(-tail);
}

export function compactImageGenerationContext(params: ChatGenerateParams): ChatGenerateParams {
  if (params.requestIntent !== "image-generation") return params;
  return {
    ...params,
    persona: [
      boundedBackground(params.persona, 7_500, 4_500),
      "IMAGE_OUTPUT_CONTRACT: The user requested a generated image. Make the image directly. For open-ended requests, choose a fitting visual rather than asking for a vibe or setting. Preserve supplied subject/reference identities. A text-only answer is not task completion.",
    ].join("\n\n"),
    summary: boundedBackground(params.summary, 2_200, 3_600),
    history: params.history.slice(-8).map(turn => ({
      role: turn.role,
      content: boundedBackground(turn.content, turn.role === "user" ? 1_300 : 700, turn.role === "user" ? 1_000 : 500),
    })),
  };
}
