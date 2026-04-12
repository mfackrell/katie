import type { LlmProvider } from "@/lib/providers/types";
import type { ActorRoutingIntent, ActorRoutingProfile, ActorRoutingProvider, ActorRoutingTag } from "@/lib/types/chat";

export const ACTOR_ROUTING_PROFILE_VERSION = "v1";
const ACTOR_ROUTING_VALUE_MIN = -3;
const ACTOR_ROUTING_VALUE_MAX = 3;

export const ACTOR_ROUTING_PROVIDER_KEYS: ActorRoutingProvider[] = ["openai", "google", "anthropic", "grok"];
export const ACTOR_ROUTING_TAG_KEYS: ActorRoutingTag[] = [
  "coding",
  "debugging",
  "architecture",
  "writing",
  "emotional-nuance",
  "conversational",
  "interpersonal",
  "empathy",
  "multimodal",
  "research",
  "reflection"
];
export const ACTOR_ROUTING_INTENT_KEYS: ActorRoutingIntent[] = [
  "general",
  "technical-debugging",
  "architecture-design",
  "coding-implementation",
  "writing-editing",
  "research-analysis",
  "emotional-support"
];

function zeroProviderBoosts(): Record<ActorRoutingProvider, number> {
  return { openai: 0, google: 0, anthropic: 0, grok: 0 };
}

function zeroTagBoosts(): Record<ActorRoutingTag, number> {
  return {
    coding: 0,
    debugging: 0,
    architecture: 0,
    writing: 0,
    "emotional-nuance": 0,
    conversational: 0,
    interpersonal: 0,
    empathy: 0,
    multimodal: 0,
    research: 0,
    reflection: 0
  };
}

function zeroIntentProviderBoosts(): Record<ActorRoutingIntent, Record<ActorRoutingProvider, number>> {
  return {
    general: zeroProviderBoosts(),
    "technical-debugging": zeroProviderBoosts(),
    "architecture-design": zeroProviderBoosts(),
    "coding-implementation": zeroProviderBoosts(),
    "writing-editing": zeroProviderBoosts(),
    "research-analysis": zeroProviderBoosts(),
    "emotional-support": zeroProviderBoosts()
  };
}

export function createNeutralActorRoutingProfile(summary = "Neutral actor routing profile."): ActorRoutingProfile {
  return {
    providerBoosts: zeroProviderBoosts(),
    tagBoosts: zeroTagBoosts(),
    intentProviderBoosts: zeroIntentProviderBoosts(),
    summary,
    generatedByModel: null,
    version: ACTOR_ROUTING_PROFILE_VERSION
  };
}

function clampValue(value: number): number {
  return Math.max(ACTOR_ROUTING_VALUE_MIN, Math.min(ACTOR_ROUTING_VALUE_MAX, Number(value.toFixed(3))));
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Invalid ${label}`);
  }
  return input as Record<string, unknown>;
}

function requireFiniteNumber(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new Error(`Invalid ${label}`);
  }
  return clampValue(input);
}

function parseProviderBoosts(input: unknown): Record<ActorRoutingProvider, number> {
  const record = requireRecord(input, "providerBoosts");
  const parsed = zeroProviderBoosts();
  for (const key of ACTOR_ROUTING_PROVIDER_KEYS) {
    parsed[key] = requireFiniteNumber(record[key], `providerBoosts.${key}`);
  }
  return parsed;
}

function parseTagBoosts(input: unknown): Record<ActorRoutingTag, number> {
  const record = requireRecord(input, "tagBoosts");
  const parsed = zeroTagBoosts();
  for (const key of ACTOR_ROUTING_TAG_KEYS) {
    parsed[key] = requireFiniteNumber(record[key], `tagBoosts.${key}`);
  }
  return parsed;
}

function parseIntentProviderBoosts(input: unknown): Record<ActorRoutingIntent, Record<ActorRoutingProvider, number>> {
  const record = requireRecord(input, "intentProviderBoosts");
  const parsed = zeroIntentProviderBoosts();
  for (const intent of ACTOR_ROUTING_INTENT_KEYS) {
    parsed[intent] = parseProviderBoosts(record[intent]);
  }
  return parsed;
}

export function normalizeActorRoutingProfile(input: unknown): ActorRoutingProfile {
  const record = requireRecord(input, "actorRoutingProfile");
  if (typeof record.summary !== "string" || !record.summary.trim()) {
    throw new Error("Invalid summary");
  }
  if (!(typeof record.generatedByModel === "string" || record.generatedByModel === null)) {
    throw new Error("Invalid generatedByModel");
  }
  if (typeof record.version !== "string" || !record.version.trim()) {
    throw new Error("Invalid version");
  }

  return {
    providerBoosts: parseProviderBoosts(record.providerBoosts),
    tagBoosts: parseTagBoosts(record.tagBoosts),
    intentProviderBoosts: parseIntentProviderBoosts(record.intentProviderBoosts),
    summary: record.summary.trim().slice(0, 240),
    generatedByModel: record.generatedByModel,
    version: record.version.trim()
  };
}

export function parseActorRoutingProfileFromJson(raw: string): ActorRoutingProfile {
  return normalizeActorRoutingProfile(JSON.parse(raw.trim()));
}

export function buildActorRoutingClassifierPrompt(args: {
  actorName: string;
  actorPurpose: string;
  actorSystemPrompt: string;
}): string {
  return `You are a strict JSON classifier that generates an ActorRoutingProfile for model routing bias.

Task:
Given an actor’s purpose/system prompt, produce a SOFT routing affinity profile that biases scoring.
This profile is additive only. It must NOT imply hard model locks or exclusions.

Output rules:
- Return ONLY valid JSON.
- No markdown.
- No prose before or after JSON.
- Follow the schema exactly.
- Use only the allowed provider and tag keys.
- All numeric values must be finite numbers in range [-3, 3].
- Prefer small magnitudes. Most values should be between -1.5 and +1.5.
- Use 0 for neutral.
- If uncertain, stay conservative and near neutral.

Schema (exact):
{
  "providerBoosts": {
    "openai": number,
    "google": number,
    "anthropic": number,
    "grok": number
  },
  "tagBoosts": {
    "coding": number,
    "debugging": number,
    "architecture": number,
    "writing": number,
    "emotional-nuance": number,
    "conversational": number,
    "interpersonal": number,
    "empathy": number,
    "multimodal": number,
    "research": number,
    "reflection": number
  },
  "intentProviderBoosts": {
    "general": { "openai": number, "google": number, "anthropic": number, "grok": number },
    "technical-debugging": { "openai": number, "google": number, "anthropic": number, "grok": number },
    "architecture-design": { "openai": number, "google": number, "anthropic": number, "grok": number },
    "coding-implementation": { "openai": number, "google": number, "anthropic": number, "grok": number },
    "writing-editing": { "openai": number, "google": number, "anthropic": number, "grok": number },
    "research-analysis": { "openai": number, "google": number, "anthropic": number, "grok": number },
    "emotional-support": { "openai": number, "google": number, "anthropic": number, "grok": number }
  },
  "summary": string,
  "generatedByModel": string | null,
  "version": string
}

Classification guidance:
- This is SOFT biasing for score adjustments only.
- Never create an exclusive winner. Never heavily penalize all but one provider.
- Keep cross-provider viability intact.
- Match actor role to capabilities:
  - coding/debugging/architecture actors → positive boosts for technical providers/tags.
  - emotionally nuanced or conversational actors → positive boosts for interpersonal/empathy/conversational tags.
  - research-focused actors → positive boosts for research/reflection tags.
  - multimodal/vision-heavy actors → positive boosts for multimodal tag and suitable providers.
- If actor purpose is broad or ambiguous, keep profile mostly neutral.
- Disfavored areas should get only mild negative values (typically no lower than -1.5 unless strongly justified).
- Keep intentProviderBoosts sparse and conservative; use near-zero when unsure.

Field rules:
- summary: one short sentence describing why the profile was chosen.
- generatedByModel: use null.
- version: set to "v1".

Now classify this actor.

Actor name:
${args.actorName}

Actor purpose:
${args.actorPurpose}

Actor system prompt:
${args.actorSystemPrompt}`;
}

export async function generateActorRoutingProfile(args: {
  actorName: string;
  actorPurpose: string;
  actorSystemPrompt: string;
  decisionProvider: { provider: LlmProvider; modelId: string } | null;
}): Promise<ActorRoutingProfile> {
  if (!args.decisionProvider) {
    return createNeutralActorRoutingProfile("Neutral profile used because no control-plane model was available.");
  }

  const prompt = buildActorRoutingClassifierPrompt(args);

  try {
    const response = await args.decisionProvider.provider.generate({
      name: "Katie Router",
      persona: prompt,
      summary: "",
      user: "Return JSON only.",
      history: [],
      modelId: args.decisionProvider.modelId,
      requestIntent: "assistant-reflection"
    });
    return parseActorRoutingProfileFromJson(response.text);
  } catch (error) {
    console.warn("[ActorRoutingProfile] classifier_failed", {
      provider: args.decisionProvider.provider.name,
      modelId: args.decisionProvider.modelId,
      error: error instanceof Error ? error.message : String(error)
    });
    return createNeutralActorRoutingProfile("Neutral profile used because routing profile classification failed.");
  }
}
