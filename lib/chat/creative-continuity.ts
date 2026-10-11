/**
 * Creative-conversation routing and quality checks.
 * The router remains authoritative for tools, factual work, visual inputs,
 * and explicit model overrides. This layer only biases ongoing fiction.
 */
export type NarrativeTurn = { role: "user" | "assistant"; content: string };

const DIRECT_CREATIVE_REQUEST =
  /\b(?:role[ -]?play|in character|fictional scene|write (?:a |the |another )?(?:story|scene|chapter|dialogue|fiction)|continue (?:the |our )?(?:story|scene|narrative)|tell (?:me )?(?:a |the )?story|create (?:a |the )?(?:fictional )?(?:scene|character)|write what happens next)\b/i;
const CONTINUE_SIGNAL =
  /^(?:again\b|more\b|next\b|continue\b|keep (?:going|writing|the scene going|it going)\b|go on\b|don't stop\b|don’t stop\b|then what\b|and then\b|what happens next\b|what does .{1,40} do next\b)/i;
const TASK_SWITCH =
  /\b(?:new topic|switch topics?|different subject|unrelated question|actually,? (?:new|switch))\b/i;
const NON_NARRATIVE_REQUEST =
  /^(?:review|summari[sz]e|analy[sz]e|critique|compare|explain|research|search|find|fix|implement|deploy|check|debug|calculate|translate|what (?:is|are|was|were|model|time)|why (?:is|does|did)|how (?:do|does|can|much|many)|where (?:is|are)|who (?:is|are)|can you (?:check|fix|find|review|explain|research|look up))\b/i;

function unbox(text: string): string {
  if (!text.trim().startsWith("{")) return text;
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && "text" in value &&
        typeof (value as { text?: unknown }).text === "string") {
      return (value as { text: string }).text;
    }
  } catch { /* Raw prose is allowed. */ }
  return text;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
}

/** Do not mistake a technical assistant's long answer for a continuing fictional scene. */
export function looksLikeFictionalPassage(text: string): boolean {
  const prose = unbox(text);
  if (words(prose).length < 85 || /(?:```|^#{1,4} |\b(?:SQL query|API endpoint|deployment|GitHub|Supabase)\b)/im.test(prose)) return false;
  const paragraphs = prose.split(/\n\s*\n/).filter(Boolean).length;
  const dialogue = /[“”]|(?:^|\n)\s*["'][A-Z][^\n]{4,80}["']/m.test(prose);
  const physicalOrNarrativeAction = /\b(?:I|she|he|they|we)\s+(?:look|reach|turn|step|move|walk|run|lean|pull|push|touch|take|hold|whisper|say|said|ask|asked|watch|watched|stand|stood|sit|sat|feel|felt|lift|drop|stop|smile|laugh|grin|kiss|grab|slide|come|came|begin|began)\b/i.test(prose);
  return paragraphs >= 3 && dialogue && physicalOrNarrativeAction;
}

/** Keeps short "again"/"more"/"continue" turns in a narrative when the preceding story is established. */
export function isCreativeNarrativeTurn(
  message: string,
  history: NarrativeTurn[],
  options: { hasVisualInput?: boolean; hasVideoInput?: boolean; hasRepoContext?: boolean; hasManualOverride?: boolean } = {},
): boolean {
  if (options.hasVisualInput || options.hasVideoInput || options.hasRepoContext || options.hasManualOverride) return false;
  const prompt = message.trim();
  if (!prompt || TASK_SWITCH.test(prompt)) return false;
  if (DIRECT_CREATIVE_REQUEST.test(prompt)) return true;
  if (NON_NARRATIVE_REQUEST.test(prompt)) return false;
  const lastAssistant = [...history].reverse().find(turn => turn.role === "assistant");
  if (!lastAssistant || !looksLikeFictionalPassage(lastAssistant.content)) return false;
  // Ordinary follow-ups to established scenes remain narrative unless they ask to
  // leave the scene. Bound implicit classification to avoid swallowing lengthy tasks.
  return prompt.length <= 550 || CONTINUE_SIGNAL.test(prompt);
}

export function preferredClaudeCreativeModel(availableModels: string[]): string | null {
  const usable = availableModels.filter(model =>
    /^claude-[a-z0-9.-]+$/i.test(model) &&
    !/(?:image|embedding|tool|code|vision-only)/i.test(model)
  );
  return usable.find(model => /^claude-fable-5[.-]1(?:$|-)/i.test(model)) ??
    usable.find(model => /^claude-fable/i.test(model)) ??
    usable.find(model => /^claude-sonnet-5/i.test(model)) ??
    usable.find(model => /^claude-opus-5/i.test(model)) ??
    usable.find(model => /^claude-sonnet/i.test(model)) ??
    usable.find(model => /^claude-opus/i.test(model)) ?? null;
}

export const CREATIVE_CONTINUITY_INSTRUCTIONS = [
  "CREATIVE_SCENE_CONTINUITY (only for fictional/narrative interaction):",
  "Continue the established fictional scene in the same narrative perspective,",
  "voice, relationships, and timeline unless the user requests a change.",
  "Respond directly to the user's latest contribution. Advance the events",
  "with at least one meaningful, plausible new development rather than",
  "replaying, paraphrasing or escalating the same beat repeatedly.",
  "Preserve established characters and story details; do not contradict",
  "earlier events or invent facts outside the fictional frame.",
  "Vary sentence structures, dialogue and pacing, and avoid recurring",
  "stock openings, catchphrases and identical action sequences.",
  "Write naturally in scene, not as commentary about your writing.",
  "Respect all applicable content and provider safety requirements."
].join(" ");

export const CREATIVE_REWRITE_INSTRUCTIONS = [
  "CREATIVE_ORIGINALITY_REWRITE: A previous draft was rejected because it",
  "substantially repeated earlier assistant prose. Reimagine THIS continuation.",
  "Preserve the last scene's characters, perspective and continuity, but",
  "introduce materially different next actions, dialogue, and consequences",
  "that respond to the latest user message.",
  "Do not merely paraphrase earlier sentences, list the same gestures,",
  "or restart the scene. Return only the rewritten story continuation."
].join(" ");

/** Long shared five-word runs are strong evidence of reused prose, not merely the same topic. */
export function assessCreativeRepetition(
  candidate: string, previousAssistantTexts: string[],
): { repetitive: boolean; maxOverlap: number; matchingPhrases: number } {
  const current = words(unbox(candidate));
  if (current.length < 70) return { repetitive: false, maxOverlap: 0, matchingPhrases: 0 };
  const gramSize = 5;
  const grams = (tokens: string[]): Set<string> => new Set(
    Array.from({ length: Math.max(0, tokens.length - gramSize + 1) },
      (_, i) => tokens.slice(i, i + gramSize).join(" "))
  );
  const candidateGrams = grams(current);
  let maxOverlap = 0;
  let matchingPhrases = 0;
  for (const prior of previousAssistantTexts.slice(-4)) {
    const tokens = words(unbox(prior));
    if (tokens.length < 70) continue;
    const priorGrams = grams(tokens);
    let shared = 0;
    for (const fragment of candidateGrams) if (priorGrams.has(fragment)) shared++;
    const overlap = shared / Math.max(1, Math.min(candidateGrams.size, priorGrams.size));
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      matchingPhrases = shared;
    }
  }
  return {
    repetitive: maxOverlap >= 0.38 && matchingPhrases >= 18,
    maxOverlap: Number(maxOverlap.toFixed(3)),
    matchingPhrases,
  };
}

/** At most one rewrite: avoid infinite retries and prefer the less repetitive valid answer. */
export async function improveCreativeOriginality(args: {
  text: string;
  priorAssistantTexts: string[];
  rewrite: () => Promise<string | null>;
}): Promise<{ text: string; revised: boolean; originalOverlap: number; finalOverlap: number }> {
  const prior = assessCreativeRepetition(args.text, args.priorAssistantTexts);
  if (!prior.repetitive) return {
    text: args.text, revised: false, originalOverlap: prior.maxOverlap, finalOverlap: prior.maxOverlap,
  };
  try {
    const redraft = (await args.rewrite())?.trim();
    if (redraft && words(redraft).length >= 65) {
      const next = assessCreativeRepetition(redraft, args.priorAssistantTexts);
      if (next.maxOverlap < prior.maxOverlap) return {
        text: redraft, revised: true,
        originalOverlap: prior.maxOverlap, finalOverlap: next.maxOverlap,
      };
    }
  } catch { /* Return the original answer rather than fail the user's request. */ }
  return { text: args.text, revised: false, originalOverlap: prior.maxOverlap, finalOverlap: prior.maxOverlap };
}
