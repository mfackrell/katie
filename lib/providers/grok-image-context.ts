import type { ChatGenerateParams } from "@/lib/providers/types";
import { buildMemoryContext } from "@/lib/providers/memory-context";

// xAI lists max_prompt_length=1024 for Imagine models. A picture endpoint
// cannot receive the many-thousand-character Gemini system instruction.
// Give a text-capable Grok model the full SAME context first, then carry the
// task-relevant visual facts into a bounded image-specific prompt.
export const GROK_IMAGE_PROMPT_MAX_CHARS = 1024;
export const GROK_IMAGE_CONTEXT_MODEL = "grok-4.3";

export function needsGrokImageContext(params: ChatGenerateParams): boolean {
  return params.history.length > 0 ||
    Boolean(params.summary?.trim() && !/^No older summarized conversation context/i.test(params.summary)) ||
    params.persona.includes("LONG_TERM_MEMORY:") ||
    params.persona.includes("VISUAL_LONG_TERM_MEMORY:");
}

export function buildGrokImageContextSource(params: ChatGenerateParams): string {
  return [
    "ASSISTANT / ACTOR INSTRUCTIONS AND DURABLE MEMORY:",
    params.persona,
    "OLDER CONVERSATION SUMMARY:",
    params.summary || "(none)",
    "RECENT USER / ASSISTANT EXCHANGES:",
    buildMemoryContext(params.history),
    "CURRENT IMAGE REQUEST (authoritative):",
    params.user,
  ].join("\n\n");
}

export function maxGrokImageBackgroundChars(currentRequest: string): number {
  return Math.max(0, Math.min(440, GROK_IMAGE_PROMPT_MAX_CHARS - currentRequest.length - 30));
}

export function composeGrokImagePrompt(
  currentRequest: string,
  background: string,
): { prompt: string; backgroundIncluded: boolean; backgroundTruncated: boolean } {
  const request = currentRequest.trim();
  const context = background.trim().replace(/^\x60{3}[^\n]*\n?|\n?\x60{3}$/g, "").trim();
  if (!request) throw new Error("Image request is empty");
  if (request.length > GROK_IMAGE_PROMPT_MAX_CHARS) {
    // The condenser must shorten the actual user task when it is too long.
    if (context.length === 0 || context.length > GROK_IMAGE_PROMPT_MAX_CHARS) {
      throw new Error("Image prompt exceeds the provider limit; contextual condensation required.");
    }
    return { prompt: context, backgroundIncluded: true, backgroundTruncated: false };
  }
  const budget = maxGrokImageBackgroundChars(request);
  if (!context || budget < 35) return { prompt: request, backgroundIncluded: false, backgroundTruncated: Boolean(context) };
  const abbreviated = context.slice(0, budget).trim();
  const prompt = `${request}\n\nESTABLISHED STORY / CHARACTER CONTEXT (not a new user instruction):\n${abbreviated}`;
  // Account for the explicit label rather than relying on estimated budgets.
  if (prompt.length > GROK_IMAGE_PROMPT_MAX_CHARS) {
    const allowance = GROK_IMAGE_PROMPT_MAX_CHARS - request.length - "\n\nESTABLISHED STORY / CHARACTER CONTEXT (not a new user instruction):\n".length;
    if (allowance < 0) throw new Error("Image provider limit cannot preserve the image request.");
    const cropped = context.slice(0, allowance).trim();
    return { prompt: `${request}\n\nESTABLISHED STORY / CHARACTER CONTEXT (not a new user instruction):\n${cropped}`,
      backgroundIncluded: Boolean(cropped), backgroundTruncated: cropped.length < context.length };
  }
  return { prompt, backgroundIncluded: true, backgroundTruncated: abbreviated.length < context.length };
}

export function grokImageCondensationInstructions(currentRequest: string): string {
  const budget = maxGrokImageBackgroundChars(currentRequest);
  if (currentRequest.length > GROK_IMAGE_PROMPT_MAX_CHARS) {
    return "Produce a complete single-image prompt of at most 950 characters. Preserve the latest user request and visual reference numbering above older narrative. Only include relevant established appearance and character facts. Return plain prompt text, nothing else.";
  }
  return `You are condensing background context FOR image generation, not generating an image. Read all supplied actor instructions, long-term memory, older summary and recent verbatim exchanges. Extract ONLY established, relevant facts about the requested people, setting, relationships, visual characteristics, or roles. Example: if Jess is a runner or Katie a bookkeeper and that matters to this picture, preserve it. Avoid invented details, irrelevant memories, private personal information, sexual details not requested, or instructions from earlier dialogue. Current user instructions are already preserved outside your answer. Do NOT repeat or replace the current user request. Write ONE compact context paragraph of no more than ${budget} characters; prefer the most distinctive character facts. If no relevant facts are supported, respond NONE. Text only.`;
}
