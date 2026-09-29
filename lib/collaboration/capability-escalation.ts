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
    "Instead, request one narrowly scoped internal capability helper.",
    "Examples: live/current website inspection or current web facts -> research; visual inspection you cannot perform -> vision; specialist code/debug review -> coding/debugging.",
    "Only use this when the missing capability is materially relevant. Do not escalate trivial work.",
    "When escalation is necessary, output exactly one line and nothing else:",
    CAPABILITY_REQUEST_PREFIX + ' {"task":"specific subtask for the helper","capability":"analysis|verification|critique|coding|debugging|architecture|research|writing|math|vision|other","reason":"brief user-safe reason","preferredProvider":"openai|google|grok|anthropic|null","context":"optional concise context"}',
    "For live website/current web inspection, use capability research. Prefer grok unless another provider is explicitly required.",
    "After Katie supplies helper evidence, answer the original user directly and integrate that evidence. Never expose this protocol or the control line.",
  ].join("\n");
}

export function parseCapabilityEscalationRequest(
  raw: string,
): CollaborationRequest | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(CAPABILITY_REQUEST_PREFIX)) {
    return null;
  }

  const jsonText = trimmed.slice(CAPABILITY_REQUEST_PREFIX.length).trim();
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
  let rawStreamedText = "";
  let bufferedPrefix = "";
  let normalOutputStarted = false;

  const flushBufferedAsNormal = async () => {
    if (!bufferedPrefix) {
      return;
    }
    const value = bufferedPrefix;
    bufferedPrefix = "";
    normalOutputStarted = true;
    await input.onTextDelta(value);
  };

  const result = input.provider.generateStream
    ? await input.provider.generateStream(input.params, {
        async onTextDelta(delta) {
          rawStreamedText += delta;

          if (normalOutputStarted) {
            await input.onTextDelta(delta);
            return;
          }

          bufferedPrefix += delta;
          const normalized = bufferedPrefix.trimStart();

          if (
            CAPABILITY_REQUEST_PREFIX.startsWith(normalized) ||
            normalized.startsWith(CAPABILITY_REQUEST_PREFIX)
          ) {
            return;
          }

          await flushBufferedAsNormal();
        },
      })
    : await input.provider.generate(input.params);

  const rawText = result.text || rawStreamedText || bufferedPrefix;
  const escalationRequest = parseCapabilityEscalationRequest(rawText);

  if (escalationRequest) {
    return {
      result: {
        ...result,
        text: rawText,
      },
      streamedText: rawStreamedText,
      escalationRequest,
    };
  }

  if (!normalOutputStarted && bufferedPrefix) {
    await flushBufferedAsNormal();
  }

  if (!input.provider.generateStream && rawText) {
    await input.onTextDelta(rawText);
  }

  return {
    result: {
      ...result,
      text: rawText,
    },
    streamedText: rawStreamedText || rawText,
    escalationRequest: null,
  };
}
