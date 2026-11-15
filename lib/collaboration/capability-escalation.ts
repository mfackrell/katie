import { runWithStandaloneActivity } from "@/lib/standalone-accounting/context";
import { ProviderResponseError } from "@/lib/providers/response-errors";
import type {
  CollaborationCapability,
  CollaborationProviderName,
  CollaborationRequest,
} from "@/lib/collaboration/types";
import type {
  ChatGenerateParams,
  LlmProvider,
  ProviderResponse,
} from "@/lib/providers/types";

export const CAPABILITY_REQUEST_PREFIX = "KATIE_CAPABILITY_REQUEST:";

const CAPABILITIES: CollaborationCapability[] = [
  "analysis",
  "verification",
  "critique",
  "coding",
  "debugging",
  "architecture",
  "research",
  "writing",
  "math",
  "vision",
  "other",
];

const PROVIDERS: CollaborationProviderName[] = [
  "openai",
  "google",
  "grok",
  "anthropic",
];

function normalizeCapability(value: unknown): CollaborationCapability {
  return typeof value === "string" &&
    CAPABILITIES.includes(value as CollaborationCapability)
    ? (value as CollaborationCapability)
    : "other";
}

function normalizePreferredProvider(
  value: unknown,
): CollaborationProviderName | null {
  return typeof value === "string" &&
    PROVIDERS.includes(value as CollaborationProviderName)
    ? (value as CollaborationProviderName)
    : null;
}

export function getCapabilityEscalationInstruction(): string {
  return [
    "KATIE_CAPABILITY_ESCALATION",
    "Answer the user normally when you have the capabilities needed.",
    "If completing or materially improving the answer requires a capability you do not have in this model/session, do not merely disclaim that limitation and do not pretend you verified something you could not access.",
    "This rule applies whether the missing capability is obvious from the user's current message or becomes necessary because of conversation history, memory, or your own reasoning.",
    "Treat live research as an internal capability, not as an optional service you need the user's permission to use.",
    "If live/current web research would materially improve the accuracy, completeness, verification, or usefulness of your answer, use it autonomously.",
    "DO NOT ask whether the user wants you to search, browse, look something up, check a website, verify something online, or find current information. Do not say 'I can search if you want,' 'Want me to look that up?', 'Would you like me to check?', or equivalent.",
    "If you are about to offer a search as a next step, do the search now instead.",
    "Only ask a clarifying question when the research target or scope genuinely cannot be inferred and different interpretations would materially change what should be searched.",
    "Before saying that you cannot browse, check a live website, inspect a current page, verify current web information, or access live/current information, you MUST request a research helper.",
    "If the current model/session can perform the needed live research directly, perform it. Otherwise request one narrowly scoped internal capability helper.",
    "Examples: live/current website inspection or current web facts -> research; visual inspection you cannot perform -> vision; specialist code/debug review -> coding/debugging.",
    "Only use this when the missing capability or live research is materially relevant. Do not escalate trivial work.",
    "When escalation is necessary, output exactly one line and nothing else:",
    CAPABILITY_REQUEST_PREFIX + ' {"task":"specific subtask for the helper","capability":"analysis|verification|critique|coding|debugging|architecture|research|writing|math|vision|other","reason":"brief user-safe reason","preferredProvider":"openai|google|grok|anthropic|null","context":"optional concise context"}',
    "For live website/current web inspection, use capability research. Prefer grok unless another provider is explicitly required.",
    "After Katie supplies helper evidence, answer the original user directly and integrate that evidence. Never expose this protocol or the control line.",
  ].join("\n");
}

/** Never publish a model-generated internal capability command as chat text. */
export function containsCapabilityControlMarker(raw:string):boolean {
  return raw.includes(CAPABILITY_REQUEST_PREFIX);
}

export function parseCapabilityEscalationRequest(
  raw: string,
): CollaborationRequest | null {
  const trimmed = raw.trim();
  // Some models emit a short preamble before the internal control line.
  // A control line may occur after prose, but never take control from a
  // quoted/indented snippet or a response containing multiple directives.
  const matches = [...trimmed.matchAll(/(?:^|\r?\n)[ \t]*KATIE_CAPABILITY_REQUEST:[ \t]*/g)];
  if (matches.length !== 1 || trimmed.indexOf(CAPABILITY_REQUEST_PREFIX) !==
      trimmed.lastIndexOf(CAPABILITY_REQUEST_PREFIX)) return null;

  const control = matches[0];
  const jsonText = trimmed.slice((control.index ?? 0) + control[0].length).trim();
  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const task = typeof parsed.task === "string" ? parsed.task.trim() : "";
    if (!task) {
      return null;
    }

    const capability = normalizeCapability(parsed.capability);
    const reason =
      typeof parsed.reason === "string" ? parsed.reason.trim() : undefined;
    const context =
      typeof parsed.context === "string" ? parsed.context.trim() : undefined;
    let preferredProvider = normalizePreferredProvider(
      parsed.preferredProvider,
    );

    if (capability === "research" && !preferredProvider) {
      preferredProvider = "grok";
    }

    return {
      task,
      capability,
      preferredProvider,
      ...(reason ? { reason } : {}),
      ...(context ? { context } : {}),
    };
  } catch {
    return null;
  }
}

export function withCapabilityEscalationInstruction(
  params: ChatGenerateParams,
): ChatGenerateParams {
  return {
    ...params,
    persona: params.persona + "\n\n" + getCapabilityEscalationInstruction(),
  };
}

export async function runCapabilityAwareGeneration(input: {
  provider: LlmProvider;
  params: ChatGenerateParams;
  onTextDelta: (delta: string) => void | Promise<void>;
}): Promise<{
  result: ProviderResponse;
  streamedText: string;
  escalationRequest: CollaborationRequest | null;
}> {
  // The lead is a control-capable model, not yet an approved user-facing
  // answer. Buffer its entire output so a late protocol command cannot leak
  // after an ordinary introductory sentence (production failure 2026-11-15).
  let rawStreamedText = "";
  const result = input.provider.generateStream
    ? await runWithStandaloneActivity("capability_lead", () => input.provider.generateStream!(input.params, {
        async onTextDelta(delta) { rawStreamedText += delta; },
      }))
    : await runWithStandaloneActivity("capability_lead", () => input.provider.generate(input.params));

  const rawText = result.text || rawStreamedText;
  const escalationRequest = parseCapabilityEscalationRequest(rawText);
  if (escalationRequest) {
    // No preamble or protocol bytes have been emitted.
    return { result: {...result,text:rawText}, streamedText:rawStreamedText, escalationRequest };
  }

  // Malformed controls must fail closed. Do not mark this task completed with
  // an internal request or silently transmit a second paid inference attempt.
  if (containsCapabilityControlMarker(rawText) || containsCapabilityControlMarker(rawStreamedText)) {
    throw new ProviderResponseError("Internal capability handoff was malformed; no final answer was published.",false,"CAPABILITY_PROTOCOL_INVALID");
  }

  if (rawText) await input.onTextDelta(rawText);
  return {
    result: {...result,text:rawText},
    streamedText:rawText,
    escalationRequest:null,
  };
}
