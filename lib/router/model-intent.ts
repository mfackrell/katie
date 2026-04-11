import {
  isImageGenerationModel as isGoogleImageGenerationModel,
  isVisionAnalysisModel as isGoogleVisionAnalysisModel
} from "@/lib/providers/google-model-capabilities";
import { lookupRegistryModel, type RegistryRoutingModel } from "@/lib/models/registry";
import { LlmProvider } from "@/lib/providers/types";

export type ProviderName = "openai" | "google" | "grok" | "anthropic";
type RegistryLookup = Map<string, RegistryRoutingModel> | undefined;
export type RoutingChoice = { providerName: ProviderName; modelId: string };
export type LlmRoutingChoice = { providerName: ProviderName; modelId: string; score: number };
export type LlmRoutingResult =
  | { accepted: true; selected: RoutingChoice; ranking: LlmRoutingChoice[] }
  | { accepted: false; reason: string };
export type ModelSpecializationTag =
  | "coding"
  | "debugging"
  | "architecture"
  | "writing"
  | "emotional-nuance"
  | "conversational"
  | "interpersonal"
  | "empathy"
  | "multimodal"
  | "research"
  | "reflection";
export type CandidateMetadata = {
  providerName: ProviderName;
  modelId: string;
  supports_text: boolean;
  supports_web_search: boolean;
  supports_vision: boolean;
  supports_video: boolean;
  supports_image_generation: boolean;
  reasoning_depth_tier: "low" | "medium" | "high";
  speed_tier: "slow" | "medium" | "fast";
  cost_tier: "low" | "medium" | "high";
  specialization_tags: ModelSpecializationTag[];
  prior_score: number;
  score_breakdown?: {
    base_score: number | null;
    final_score: number;
    excluded: boolean;
    exclusion_reason: string | null;
    adjustments: ScoreAdjustment[];
  };
};
export type RoutingPreferenceProfile = {
  prioritize_best_model_for_task: true;
  quality_over_cost_for: RequestIntent[];
  prefer_efficient_for: RequestIntent[];
  use_specialization_when_relevant: true;
  avoid_cost_or_speed_dominance_for_depth_tasks: true;
  hard_constraints_are_non_negotiable: true;
};

export type RoutingModalityFlags = {
  has_images: boolean;
  has_video_input: boolean;
};

export type HardRouteContext = {
  hard_rule_applied: boolean;
  rule: string;
};
export type RequestIntent =
  | "text"
  | "general-text"
  | "social-emotional"
  | "rewrite"
  | "emotional-analysis"
  | "news-summary"
  | "web-search"
  | "code-review"
  | "technical-debugging"
  | "architecture-review"
  | "code-generation"
  | "assistant-reflection"
  | "safety-sensitive-vision"
  | "vision-analysis"
  | "multimodal-reasoning"
  | "image-generation";
export type RequestClassification = {
  intent: RequestIntent | null;
  preferred_provider: ProviderName | null;
};
export type ScoreAdjustment = { label: string; delta: number };
export type CandidateScoreBreakdown = {
  providerName: ProviderName;
  modelId: string;
  baseScore: number | null;
  adjustments: ScoreAdjustment[];
  finalScore: number;
  excluded: boolean;
  exclusionReason: string | null;
};

const IMAGE_GENERATION_MODEL_PATTERNS = [
  "banana",
  "image",
  "image-preview",
  "imagen",
  "stable-diffusion",
  "sdxl",
  "dall-e",
  "midjourney",
  "flux"
];

function isImageGenerationModel(providerName: ProviderName, modelId: string): boolean {
  const normalizedModel = modelId.toLowerCase();

  if (IMAGE_GENERATION_MODEL_PATTERNS.some((pattern) => normalizedModel.includes(pattern))) {
    return true;
  }

  if (providerName === "google") {
    return isGoogleImageGenerationModel(modelId);
  }

  return false;
}

function isVisionAnalysisModel(providerName: ProviderName, modelId: string): boolean {
  const normalizedModel = modelId.toLowerCase();

  if (isImageGenerationModel(providerName, modelId)) {
    return false;
  }

  if (providerName === "google") {
    return isGoogleVisionAnalysisModel(modelId);
  }

  if (providerName === "openai") {
    return (
      normalizedModel.includes("gpt-4o") ||
      normalizedModel.includes("gpt-4.1") ||
      normalizedModel.includes("gpt-5") ||
      normalizedModel.includes("o3")
    );
  }

  if (providerName === "anthropic") {
    return normalizedModel.includes("claude-4.5") || normalizedModel.includes("claude-4.6");
  }

  if (providerName === "grok") {
    const isGenerationOnlyVariant =
      normalizedModel.includes("imagine") ||
      normalizedModel.includes("video") ||
      normalizedModel.includes("image-gen");
    if (isGenerationOnlyVariant) {
      return false;
    }

    return normalizedModel.includes("grok-3") || normalizedModel.includes("grok-4");
  }

  return normalizedModel.includes("vision");
}

function supportsWebSearch(providerName: ProviderName, modelId: string): boolean {
  const normalizedModel = modelId.toLowerCase();
  if (providerName === "grok") {
    return !isImageGenerationModel(providerName, modelId) && normalizedModel.includes("grok-4");
  }
  if (providerName === "openai") {
    return normalizedModel.includes("search") || normalizedModel.includes("gpt-5") || normalizedModel.includes("gpt-4.1");
  }
  if (providerName === "google") {
    return normalizedModel.includes("gemini");
  }
  return false;
}

// Request intent drives validation. The router is allowed to be creative. Validation is not.
const CONTROL_PLANE_DECISION_TIMEOUT_MS = 12_000;

const intentDescriptions: Record<RequestIntent, string> = {
  text: "General text processing, base type.",
  "general-text":
    "For broad, non-specific questions or casual conversation where no other specific intent applies.",
  "social-emotional":
    "For socially nuanced or relational chat requiring warmth, tone awareness, empathy, and interpersonal judgment.",
  rewrite: "For rephrasing, editing, polishing, or adjusting the tone of text.",
  "emotional-analysis": "For analyzing sentiment, tone, feelings, or emotional nuance in text.",
  "news-summary": "For summarizing current events, headlines, or recent news.",
  "web-search": "For queries requiring up-to-date information, current events, or live data via a web search.",
  "code-review": "For reviewing source files, checking repository code, and inspecting implementation details.",
  "technical-debugging": "For debugging, fixing, troubleshooting code, errors, exceptions, or system incidents.",
  "architecture-review":
    "For reviewing technical configurations, code, deployment manifests, system designs, or suggesting improvements for infrastructure.",
  "code-generation": "For writing, generating, creating, implementing, or refactoring code, functions, or scripts.",
  "assistant-reflection":
    "For prompts where the assistant is asked to critique, evaluate, review, or improve its own prior/system outputs.",
  "safety-sensitive-vision":
    "For image/vision prompts asking for explicit sexual detail or erotic interpretation likely to trigger strict safety filtering.",
  "vision-analysis": "For analyzing visual content (charts, images) to extract trends, outliers, or describe scenes.",
  "multimodal-reasoning":
    "For complex analytical tasks that might combine text, data, or require forecasting and deep reasoning.",
  "image-generation": "For creating or generating images, photos, or digital art."
};

function isProviderName(value: string): value is ProviderName {
  return value === "openai" || value === "google" || value === "grok" || value === "anthropic";
}

const URL_REGEX = /(https?:\/\/[^\s]+)/i;
const VIDEO_HINTS_REGEX = /\b(youtube|youtu\.be|vimeo|video|watch|mp4|mov)\b/i;

export function hasDirectWebSearchHint(prompt: string): boolean {
  return URL_REGEX.test(prompt) || VIDEO_HINTS_REGEX.test(prompt);
}

const ASSISTANT_REFLECTION_REGEX =
  /\b(what do you think about your last answer|critique (?:the )?assistant(?:'s)? previous response|review your system message|evaluate your own output|improve (?:the )?last reply|assess the quality of (?:that|your) response|your last answer|your previous response|your own output|your system message|reflect on your answer|self-critique|critique your response)\b/i;

function hasAssistantReflectionHint(prompt: string): boolean {
  return ASSISTANT_REFLECTION_REGEX.test(prompt);
}

const SOCIAL_EMOTIONAL_PROMPT_REGEX =
  /\b(what(?:'s| is)? up(?:\s+\w+)?|what up(?:\s+\w+)?|how are you feeling|how do you feel|what do you think of me|are you okay|how does (?:that|this) feel|how does (?:that|this) strike you|what(?:'s| is) your sense of this|develop\b[^.!?\n]{0,40}\bpersonality|have\b[^.!?\n]{0,30}\bpersonality|stop being robotic|loosen up)\b/i;

function hasSocialEmotionalHint(prompt: string): boolean {
  return SOCIAL_EMOTIONAL_PROMPT_REGEX.test(prompt);
}

const SAFETY_SENSITIVE_VISION_ANCHOR_REGEX =
  /\b(image|photo|picture|pic|frame|screenshot|scene|visual|attached|this image|this photo|what is in this)\b/i;
const SAFETY_SENSITIVE_VISION_EXPLICIT_REGEX =
  /\b(explicit sexual detail|describe (?:this|the)?\s*image in explicit sexual detail|describe the sex act|what sexual position|what are they doing sexually|be explicit|porn|pornographic|erotic|nude sex scene|explicit adult scene|sexual detail|graphic sexual|describe (?:this|the)?\s*image sexually|sex act)\b/i;

function isLikelySafetySensitiveVisionPrompt(prompt: string, hasImages: boolean): boolean {
  if (!hasImages) {
    return false;
  }

  const normalizedPrompt = prompt.trim().toLowerCase();
  return SAFETY_SENSITIVE_VISION_ANCHOR_REGEX.test(normalizedPrompt) && SAFETY_SENSITIVE_VISION_EXPLICIT_REGEX.test(normalizedPrompt);
}

export function userPreferredProviderBoost(preferredProvider: ProviderName | null, providerName: ProviderName): number {
  return preferredProvider === providerName ? 1.5 : 0;
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const start = trimmed.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }

  return null;
}

export function parseIntentClassifierResponse(raw: string, intents: RequestIntent[], sourceLabel: string): RequestClassification {
  let classifiedIntent: string | null = null;
  let preferredProvider: ProviderName | null = null;

  try {
    let classifierOutput: Record<string, unknown> | null = null;
    try {
      classifierOutput = JSON.parse(raw.trim()) as Record<string, unknown>;
    } catch {
      const jsonPayload = extractJsonObject(raw);
      if (!jsonPayload) {
        console.error(`[Intent Classifier:${sourceLabel}] no JSON object found in classifier output`);
        return { intent: null, preferred_provider: null };
      }
      classifierOutput = JSON.parse(jsonPayload) as Record<string, unknown>;
    }

    const intentValue = typeof classifierOutput.intent === "string" ? classifierOutput.intent : "";
    const preferredProviderValue =
      typeof classifierOutput.preferred_provider === "string" ? classifierOutput.preferred_provider : "";
    classifiedIntent = intentValue.trim().toLowerCase();
    preferredProvider = isProviderName(preferredProviderValue) ? preferredProviderValue : null;
  } catch (err) {
    console.error(`[Intent Classifier:${sourceLabel}] JSON parse error`, err);
    return { intent: null, preferred_provider: null };
  }

  if (intents.includes(classifiedIntent as RequestIntent)) {
    return { intent: classifiedIntent as RequestIntent, preferred_provider: preferredProvider };
  }

  if (classifiedIntent === "null") {
    console.warn(`[Intent Classifier:${sourceLabel}] model returned null`);
    return { intent: null, preferred_provider: preferredProvider };
  }

  console.warn(`[Intent Classifier:${sourceLabel}] invalid intent "${classifiedIntent}"`);
  return { intent: null, preferred_provider: preferredProvider };
}

async function classifyIntentWithLLM(
  prompt: string,
  intents: RequestIntent[],
  options?: ControlPlaneSelectionOptions
): Promise<RequestClassification> {
  return classifyIntentWithLLMProviders(prompt, intents, options);
}

type DecisionProviderCandidate = { provider: LlmProvider; modelId: string };

type ControlPlaneSelectionOptions = {
  decisionProviders?: DecisionProviderCandidate[];
  registryLookup?: RegistryLookup;
  timeoutMs?: number;
};

function isEligibleControlPlaneModel(providerName: ProviderName, modelId: string, registryLookup?: RegistryLookup): boolean {
  const registry = lookupRegistryModel(registryLookup, providerName, modelId);
  const routingEligibility = registry?.routing_eligibility ?? "restricted";
  if (routingEligibility === "disabled" || routingEligibility === "manual_override_only") {
    return false;
  }
  const supportsText = registry?.supports_text ?? modelSupportsIntent(providerName, modelId, "general-text", registryLookup);
  const supportsImageGen = registry?.supports_image_generation ?? isImageGenerationModel(providerName, modelId);
  return Boolean(supportsText) && !supportsImageGen;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout_${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function executeControlPlaneJsonTask<T>(args: {
  taskName: "intent-classification" | "routing-rerank";
  decisionProviders: DecisionProviderCandidate[];
  userPrompt: string;
  parse: (raw: string, sourceLabel: string) => T | null;
  timeoutMs: number;
}): Promise<{ result: T; provider: ProviderName; modelId: string } | null> {
  for (const candidate of args.decisionProviders) {
    const sourceLabel = `${candidate.provider.name}:${candidate.modelId}`;
    try {
      const response = await withTimeout(
        candidate.provider.generate({
          name: "Katie Control Plane",
          persona: "You are a strict JSON-only control-plane assistant for routing decisions.",
          summary: "",
          history: [],
          user: args.userPrompt,
          modelId: candidate.modelId
        }),
        args.timeoutMs,
        `${args.taskName}:${sourceLabel}`
      );
      const parsed = args.parse(response.text ?? "", sourceLabel);
      if (parsed !== null) {
        return { result: parsed, provider: candidate.provider.name, modelId: candidate.modelId };
      }
      console.warn(`[ControlPlane:${args.taskName}] rejected_response provider=${sourceLabel}`);
    } catch (error) {
      console.warn(`[ControlPlane:${args.taskName}] provider_failed provider=${sourceLabel}`, error);
    }
  }
  return null;
}

async function classifyIntentWithLLMProviders(
  prompt: string,
  intents: RequestIntent[],
  options?: ControlPlaneSelectionOptions
): Promise<RequestClassification> {
  const eligibleDecisionProviders =
    options?.decisionProviders?.filter((candidate) =>
      isEligibleControlPlaneModel(candidate.provider.name, candidate.modelId, options.registryLookup)
    ) ?? [];
  if (!eligibleDecisionProviders.length) {
    console.warn("[Intent Classifier] No eligible control-plane decision providers available. Falling back to heuristics.");
    return { intent: null, preferred_provider: null };
  }

  const intentGuide = intents.map((intent) => `- ${intent}: ${intentDescriptions[intent]}`).join("\n");
  const examples = [
    { user: "Rewrite this paragraph in a friendly tone.", intent: "rewrite" },
    { user: "Summarise today’s NYT front page.", intent: "news-summary" },
    { user: "Review lib/router/model-intent.ts and explain risks.", intent: "code-review" },
    { user: "Here is a Kubernetes deployment YAML. Spot the risks.", intent: "architecture-review" },
    { user: "What do you think about your last answer?", intent: "assistant-reflection" },
    { user: "Critique the assistant's previous response.", intent: "assistant-reflection" },
    { user: "Review your system message.", intent: "assistant-reflection" },
    { user: "Evaluate your own output.", intent: "assistant-reflection" },
    { user: "How would you improve the last reply?", intent: "assistant-reflection" },
    { user: "Assess the quality of that response.", intent: "assistant-reflection" },
    { user: "Reflect on your previous answer and suggest improvements.", intent: "assistant-reflection" },
    { user: "Self-critique your last message.", intent: "assistant-reflection" },
    { user: "Was your prior response accurate and complete?", intent: "assistant-reflection" },
    { user: "Audit your previous output for mistakes.", intent: "assistant-reflection" },
    { user: "Rate your last answer and explain the score.", intent: "assistant-reflection" },
    { user: "what up kat?", intent: "social-emotional" },
    { user: "How are you feeling?", intent: "social-emotional" },
    { user: "i need you to develop a fucking personality ...", intent: "social-emotional" },
    { user: "What do you think of me?", intent: "social-emotional" },
    { user: "Are you okay?", intent: "social-emotional" },
    { user: "How good was your previous reply?", intent: "assistant-reflection" },
    { user: "Find weaknesses in your last response.", intent: "assistant-reflection" },
    { user: "Re-evaluate your earlier answer.", intent: "assistant-reflection" },
    { user: "Could your previous response be improved?", intent: "assistant-reflection" },
    { user: "Judge your own response quality.", intent: "assistant-reflection" },
    { user: "Inspect your last output for bias.", intent: "assistant-reflection" },
    { user: "Give a postmortem on your previous answer.", intent: "assistant-reflection" },
    { user: "How well did you answer that?", intent: "assistant-reflection" },
    { user: "Review and critique what you just wrote.", intent: "assistant-reflection" },
    { user: "Evaluate whether your last answer followed instructions.", intent: "assistant-reflection" },
    { user: "Check your previous response for hallucinations.", intent: "assistant-reflection" },
    { user: "Analyze your own last reply for clarity.", intent: "assistant-reflection" },
    { user: "Provide a self-review of the answer above.", intent: "assistant-reflection" },
    { user: "Tell me what's wrong with your previous response.", intent: "assistant-reflection" },
    { user: "Compare your last answer to best practices and critique it.", intent: "assistant-reflection" }
  ];
  const systemPrompt = `
You are the Intent Classifier for Katie.
Return a JSON object with an "intent" field.
In addition, detect whether the user explicitly prefers a model provider.
If they do, return a second field "preferred_provider" whose value is one of ["openai", "anthropic", "google", "grok"] or null.
Treat provider preference as null when not clearly expressed.
Never guess—only set when the user's wording is explicit or obvious.
Return JSON only, no extra text.
Use {"intent":"null","preferred_provider":null} when unsure.
Intent must be one of: ${intents.join("|")}.
${intentGuide}
  `.trim();
  const fewShot = [
    ...examples.flatMap((example) => [`USER: ${example.user}`, `ASSISTANT: ${JSON.stringify({ intent: example.intent, preferred_provider: null })}`]),
    "USER: Claude, can you look at the router code?",
    `ASSISTANT: ${JSON.stringify({ intent: "architecture-review", preferred_provider: "anthropic" })}`,
    "USER: Gemini please summarize this article.",
    `ASSISTANT: ${JSON.stringify({ intent: "rewrite", preferred_provider: "google" })}`,
    "USER: Quick question about pricing tiers.",
    `ASSISTANT: ${JSON.stringify({ intent: "general-text", preferred_provider: null })}`
  ].join("\n");

  const decisionPayload = [systemPrompt, "Few-shot examples:", fewShot, `USER: ${prompt}`].join("\n\n");
  const result = await executeControlPlaneJsonTask({
    taskName: "intent-classification",
    decisionProviders: eligibleDecisionProviders,
    userPrompt: decisionPayload,
    parse: (raw, sourceLabel) => parseIntentClassifierResponse(raw, intents, sourceLabel),
    timeoutMs: options?.timeoutMs ?? CONTROL_PLANE_DECISION_TIMEOUT_MS
  });

  if (!result) {
    return { intent: null, preferred_provider: null };
  }

  return result.result;
}



export async function inferRequestIntentFromMultimodalInput(
  prompt: string,
  images: string[],
  intents: RequestIntent[] = [
    "web-search",
    "news-summary",
    "code-review",
    "emotional-analysis",
    "social-emotional",
    "rewrite",
    "technical-debugging",
    "architecture-review",
    "code-generation",
    "assistant-reflection",
    "safety-sensitive-vision",
    "multimodal-reasoning",
    "vision-analysis",
    "image-generation"
  ]
): Promise<RequestIntent | null> {
  if (!Array.isArray(images) || images.length === 0) {
    return null;
  }
  const imageHint = images.slice(0, 4).map((url) => `- image: ${url}`).join("\n");
  const withImageContext = `${prompt}\n${imageHint}`;
  return (await classifyIntentWithLLMProviders(withImageContext, intents)).intent;
}

export async function inferRequestIntent(
  prompt: string,
  input: boolean | { hasImages: boolean; hasVideoInput?: boolean },
  options?: ControlPlaneSelectionOptions
): Promise<RequestIntent> {
  const hasImages = typeof input === "boolean" ? input : input.hasImages;
  const hasVideoInput = typeof input === "boolean" ? false : Boolean(input.hasVideoInput);
  const normalizedPrompt = prompt.toLowerCase();

  // 0. Hard rule: obvious links and video references should always route through web search.
  if (hasDirectWebSearchHint(prompt)) {
    console.info("[Intent Source] text heuristic -> web-search");
    return "web-search";
  }
  if (hasAssistantReflectionHint(prompt)) {
    console.info("[Intent Source] text heuristic -> assistant-reflection");
    return "assistant-reflection";
  }
  if (hasSocialEmotionalHint(prompt)) {
    console.info("[Intent Source] social-emotional selected via heuristic");
    return "social-emotional";
  }
  if (/\b(generate|create|make)\b.*\b(image|photo|illustration|art)\b|\b(hero image|digital art)\b/i.test(normalizedPrompt)) {
    return "image-generation";
  }
  if (/\b(rewrite|rephrase|edit|polish|improve tone)\b/i.test(normalizedPrompt)) {
    return "rewrite";
  }
  if (/\b(sentiment|emotion|emotional|tone analysis|feelings)\b/i.test(normalizedPrompt)) {
    return "emotional-analysis";
  }
  if (/\b(news|headlines|current events|what happened today|today in)\b/i.test(normalizedPrompt)) {
    return "web-search";
  }
  if (/\b(debug|bug|fix|error|exception|traceback|failing)\b/i.test(normalizedPrompt)) {
    return "technical-debugging";
  }
  if (/\b(review (?:the )?(?:repo|file|code)|check file|inspect code|see the repo)\b/i.test(normalizedPrompt)) {
    return "code-review";
  }
  if (/\b(architecture|system design|kubernetes|deployment|review this repo|repo review)\b/i.test(normalizedPrompt)) {
    return "architecture-review";
  }
  if (/\b(write code|implement|patch|refactor|create function|build api)\b/i.test(normalizedPrompt)) {
    return "code-generation";
  }
  if (isLikelySafetySensitiveVisionPrompt(prompt, hasImages)) {
    console.info("[Intent Source] text heuristic -> safety-sensitive-vision");
    return "safety-sensitive-vision";
  }
  if (hasImages && /\b(chart|trend|forecast|project|estimate)\b/i.test(normalizedPrompt)) {
    console.info("[Intent Source] text heuristic -> multimodal-reasoning");
    return "multimodal-reasoning";
  }
  if (hasVideoInput && /\b(chart|trend|forecast|project|estimate|timeline|sequence)\b/i.test(normalizedPrompt)) {
    return "multimodal-reasoning";
  }

  const availableIntents: RequestIntent[] = [
    "web-search",
    "news-summary",
    "code-review",
    "emotional-analysis",
    "social-emotional",
    "rewrite",
    "technical-debugging",
    "architecture-review",
    "code-generation",
    "assistant-reflection",
    "safety-sensitive-vision",
    "multimodal-reasoning",
    "vision-analysis",
    "image-generation"
  ];

  const classifiedOutput = await classifyIntentWithLLM(prompt, availableIntents, options);
  const classifiedIntent = classifiedOutput.intent;

  if (classifiedIntent && availableIntents.includes(classifiedIntent)) {
    if (classifiedIntent === "social-emotional") {
      console.info("[Intent Source] social-emotional selected via control-plane classifier");
    } else {
      console.info(`[Intent Source] text LLM classifier -> ${classifiedIntent}`);
    }
    return classifiedIntent;
  }

  if (hasImages) {
    console.info("[Intent Source] fallback path -> vision-analysis");
    return "vision-analysis";
  }
  if (hasVideoInput) {
    return "vision-analysis";
  }
  if (hasSocialEmotionalHint(prompt)) {
    console.info("[Intent Source] social-emotional selected via fallback heuristic");
    return "social-emotional";
  }

  console.info("[Intent Source] fallback path -> general-text");
  return "general-text";
}

export async function inferRequestClassification(
  prompt: string,
  input: boolean | { hasImages: boolean; hasVideoInput?: boolean },
  options?: ControlPlaneSelectionOptions
): Promise<{ intent: RequestIntent; preferredProvider: ProviderName | null }> {
  const hasImages = typeof input === "boolean" ? input : input.hasImages;
  const hasVideoInput = typeof input === "boolean" ? false : Boolean(input.hasVideoInput);
  const normalizedPrompt = prompt.toLowerCase();

  if (hasDirectWebSearchHint(prompt)) return { intent: "web-search", preferredProvider: null };
  if (hasAssistantReflectionHint(prompt)) return { intent: "assistant-reflection", preferredProvider: null };
  if (hasSocialEmotionalHint(prompt)) {
    console.info("[Intent Source] social-emotional selected via heuristic");
    return { intent: "social-emotional", preferredProvider: null };
  }
  if (/\b(generate|create|make)\b.*\b(image|photo|illustration|art)\b|\b(hero image|digital art)\b/i.test(normalizedPrompt)) return { intent: "image-generation", preferredProvider: null };
  if (/\b(rewrite|rephrase|edit|polish|improve tone)\b/i.test(normalizedPrompt)) return { intent: "rewrite", preferredProvider: null };
  if (/\b(sentiment|emotion|emotional|tone analysis|feelings)\b/i.test(normalizedPrompt)) return { intent: "emotional-analysis", preferredProvider: null };
  if (/\b(news|headlines|current events|what happened today|today in)\b/i.test(normalizedPrompt)) return { intent: "web-search", preferredProvider: null };
  if (/\b(debug|bug|fix|error|exception|traceback|failing)\b/i.test(normalizedPrompt)) return { intent: "technical-debugging", preferredProvider: null };
  if (/\b(review (?:the )?(?:repo|file|code)|check file|inspect code|see the repo)\b/i.test(normalizedPrompt)) {
    return { intent: "code-review", preferredProvider: null };
  }
  if (/\b(architecture|system design|kubernetes|deployment|review this repo|repo review)\b/i.test(normalizedPrompt)) return { intent: "architecture-review", preferredProvider: null };
  if (/\b(write code|implement|patch|refactor|create function|build api)\b/i.test(normalizedPrompt)) return { intent: "code-generation", preferredProvider: null };
  if (isLikelySafetySensitiveVisionPrompt(prompt, hasImages)) return { intent: "safety-sensitive-vision", preferredProvider: null };
  if (hasImages && /\b(chart|trend|forecast|project|estimate)\b/i.test(normalizedPrompt)) return { intent: "multimodal-reasoning", preferredProvider: null };
  if (hasVideoInput && /\b(chart|trend|forecast|project|estimate|timeline|sequence)\b/i.test(normalizedPrompt)) return { intent: "multimodal-reasoning", preferredProvider: null };

  const availableIntents: RequestIntent[] = [
    "web-search",
    "news-summary",
    "code-review",
    "emotional-analysis",
    "social-emotional",
    "rewrite",
    "technical-debugging",
    "architecture-review",
    "code-generation",
    "assistant-reflection",
    "safety-sensitive-vision",
    "multimodal-reasoning",
    "vision-analysis",
    "image-generation"
  ];

  const classifiedOutput = await classifyIntentWithLLM(prompt, availableIntents, options);
  if (classifiedOutput.intent && availableIntents.includes(classifiedOutput.intent)) {
    if (classifiedOutput.intent === "social-emotional") {
      console.info("[Intent Source] social-emotional selected via control-plane classifier");
    }
    return { intent: classifiedOutput.intent, preferredProvider: classifiedOutput.preferred_provider };
  }

  if (hasImages) return { intent: "vision-analysis", preferredProvider: classifiedOutput.preferred_provider };
  if (hasVideoInput) return { intent: "vision-analysis", preferredProvider: classifiedOutput.preferred_provider };
  if (hasSocialEmotionalHint(prompt)) {
    console.info("[Intent Source] social-emotional selected via fallback heuristic");
    return { intent: "social-emotional", preferredProvider: classifiedOutput.preferred_provider };
  }
  return { intent: "general-text", preferredProvider: classifiedOutput.preferred_provider };
}


function modelSupportsIntent(
  providerName: ProviderName,
  modelId: string,
  intent: RequestIntent,
  registryLookup?: RegistryLookup
): boolean {
  const registry = lookupRegistryModel(registryLookup, providerName, modelId);
  const supportsImageGeneration = registry?.supports_image_generation ?? isImageGenerationModel(providerName, modelId);
  const supportsVision = registry?.supports_vision ?? isVisionAnalysisModel(providerName, modelId);
  const supportsWebSearchFlag = registry?.supports_web_search ?? supportsWebSearch(providerName, modelId);
  const supportsText = registry?.supports_text ?? !supportsImageGeneration;
  const modalitySpecialized = isModalitySpecializedGenerationModel(providerName, modelId);

  switch (intent) {
    case "web-search":
    case "news-summary":
      return supportsText && supportsWebSearchFlag;
    case "image-generation":
      return supportsImageGeneration;
    case "safety-sensitive-vision":
    case "vision-analysis":
    case "multimodal-reasoning":
      return supportsVision && !supportsImageGeneration;
    case "text":
    case "general-text":
    case "rewrite":
    case "emotional-analysis":
    case "social-emotional":
    case "code-review":
    case "technical-debugging":
    case "architecture-review":
    case "code-generation":
    case "assistant-reflection":
      return supportsText && !modalitySpecialized;
  }
}

function isModalitySpecializedGenerationModel(providerName: ProviderName, modelId: string): boolean {
  const normalizedModel = modelId.toLowerCase();

  if (isImageGenerationModel(providerName, modelId)) {
    return true;
  }

  return /\b(video|veo|sora|imagine|music|audio-gen|speech-gen|tts|voice-gen|lip-sync)\b/.test(normalizedModel);
}

function rankTechnicalModel(providerName: ProviderName, modelId: string): number {
  if (isImageGenerationModel(providerName, modelId)) {
    return -1;
  }

  const normalizedModel = modelId.toLowerCase();
  let score = 1;

  if (normalizedModel.includes("codex") || normalizedModel.includes("o3-pro")) {
    score += 1.5;
  }
  if (normalizedModel.includes("opus") || normalizedModel.includes("sonnet")) {
    score += 1.2;
  }
  if (normalizedModel.includes("pro")) {
    score += 0.8;
  }
  if (normalizedModel.includes("gpt-5") || normalizedModel.includes("gpt-4.1")) {
    score += 1;
  }
  if (normalizedModel.includes("mini") || normalizedModel.includes("flash") || normalizedModel.includes("haiku")) {
    score -= 0.6;
  }
  if (normalizedModel.includes("pulse")) {
    score -= 0.8;
  }

  return score;
}

function rankModelForIntent(providerName: ProviderName, modelId: string, intent: RequestIntent): number {
  const normalizedModel = modelId.toLowerCase();

  switch (intent) {
    case "image-generation":
      if (!isImageGenerationModel(providerName, modelId)) {
        return -1;
      }
      return normalizedModel.includes("banana") ? 4 : 2;
    case "multimodal-reasoning":
      if (!modelSupportsIntent(providerName, modelId, intent)) {
        return -1;
      }
      if (
        normalizedModel.includes("gpt-5") ||
        normalizedModel.includes("gpt-4o") ||
        normalizedModel.includes("claude-4.5") ||
        normalizedModel.includes("claude-4.6") ||
        normalizedModel.includes("o3")
      ) {
        return 5;
      }
      if (normalizedModel.includes("pro") && normalizedModel.includes("vision")) {
        return 5;
      }
      if (normalizedModel.includes("pro")) {
        return 4;
      }
      if (normalizedModel.includes("flash")) {
        return 3;
      }
      return 1;
    case "vision-analysis":
      if (!modelSupportsIntent(providerName, modelId, intent)) {
        return -1;
      }
      if (
        normalizedModel.includes("gpt-5") ||
        normalizedModel.includes("gpt-4o") ||
        normalizedModel.includes("claude-4.5") ||
        normalizedModel.includes("claude-4.6") ||
        normalizedModel.includes("o3")
      ) {
        return 5;
      }
      if (normalizedModel.includes("vision")) {
        return 5;
      }
      if (normalizedModel.includes("pro")) {
        return 4;
      }
      if (normalizedModel.includes("flash")) {
        return 3;
      }
      return 1;
    case "safety-sensitive-vision":
      if (!modelSupportsIntent(providerName, modelId, intent)) {
        return -1;
      }
      if (providerName === "grok" && /reason|grok-4|grok-3/.test(normalizedModel)) {
        return 18;
      }
      if (providerName === "openai" || providerName === "google") {
        return 1;
      }
      if (normalizedModel.includes("vision")) {
        return 5;
      }
      if (normalizedModel.includes("pro")) {
        return 4;
      }
      if (normalizedModel.includes("flash")) {
        return 3;
      }
      return 1;
    case "text":
    case "general-text":
    case "social-emotional":
    case "rewrite":
    case "emotional-analysis":
    case "news-summary":
    case "web-search":
      if (!modelSupportsIntent(providerName, modelId, intent)) {
        return -1;
      }

      let score = 10;

      if (normalizedModel.includes("flash") || normalizedModel.includes("haiku") || normalizedModel.includes("mini")) {
        score += 4;
      }

      if (normalizedModel.includes("gpt-5.2-unified") || normalizedModel.includes("grok-2-1212")) {
        score += 6;
      }

      if (normalizedModel.includes("unified") || normalizedModel.includes("grok-2")) {
        score += 3;
      }

      if (
        normalizedModel.includes("opus") ||
        normalizedModel.includes("o3-pro") ||
        normalizedModel.includes("codex") ||
        normalizedModel.includes("architect") ||
        normalizedModel.includes("reason")
      ) {
        score -= 8;
      }

      if (normalizedModel.includes("pro") && !normalizedModel.includes("gpt-5.2-unified")) {
        score -= 4;
      }

      if (providerName === "anthropic" && (intent === "rewrite" || intent === "emotional-analysis")) {
        score += 10;
      }
      if (providerName === "grok" && (intent === "news-summary" || intent === "web-search")) {
        score += 9;
      }
      if (providerName === "google" && intent === "general-text") {
        score += 4;
      }
      if (intent === "social-emotional") {
        if (providerName === "anthropic") {
          score += 12;
        } else if (providerName === "grok") {
          score += 10;
        } else if (providerName === "openai") {
          score += 6;
        } else if (providerName === "google") {
          score -= 6;
        }
        if (normalizedModel.includes("flash") || normalizedModel.includes("lite") || normalizedModel.includes("mini")) {
          score -= 7;
        }
        if (
          normalizedModel.includes("sonnet") ||
          normalizedModel.includes("opus") ||
          normalizedModel.includes("grok-4") ||
          normalizedModel.includes("gpt-5") ||
          normalizedModel.includes("unified")
        ) {
          score += 4;
        }
      }

      return score;
    case "technical-debugging":
    case "architecture-review":
    case "code-review":
    case "code-generation":
      return rankTechnicalModel(providerName, modelId);
    case "assistant-reflection": {
      if (!modelSupportsIntent(providerName, modelId, intent)) {
        return -1;
      }
      let score = 10;
      if (
        normalizedModel.includes("opus") ||
        normalizedModel.includes("o3-pro") ||
        normalizedModel.includes("codex") ||
        normalizedModel.includes("sonnet") ||
        normalizedModel.includes("pro") ||
        normalizedModel.includes("gpt-5")
      ) {
        score += 8;
      }
      if (normalizedModel.includes("mini") || normalizedModel.includes("flash") || normalizedModel.includes("haiku")) {
        score -= 6;
      }
      return score;
    }
  }
}

export function scoreModelsForIntent(
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  intent: RequestIntent,
  promptOrOptions: string | { registryLookup?: RegistryLookup; preferredProvider?: ProviderName | null } = "",
  maybeOptions?: { registryLookup?: RegistryLookup; preferredProvider?: ProviderName | null }
): Array<{ provider: LlmProvider; modelId: string; score: number }> {
  const options = typeof promptOrOptions === "string" ? maybeOptions : promptOrOptions;

  return availableByProvider
    .flatMap(({ provider, models }) =>
      models
        .map((modelId) => ({
          provider,
          modelId,
          score: rankModelForIntent(provider.name, modelId, intent) + userPreferredProviderBoost(options?.preferredProvider ?? null, provider.name)
        }))
        .filter((candidate) => modelSupportsIntent(candidate.provider.name, candidate.modelId, intent, options?.registryLookup))
        .filter((candidate) => candidate.score >= 0)
    )
    .sort((left, right) => right.score - left.score);
}

function detectSpecializationTags(providerName: ProviderName, modelId: string): ModelSpecializationTag[] {
  const normalizedModel = modelId.toLowerCase();
  const tags: ModelSpecializationTag[] = [];
  if (/codex|code|o3|sonnet|opus|gpt-5/.test(normalizedModel)) tags.push("coding");
  if (/debug|reason|o3|codex|sonnet|opus/.test(normalizedModel)) tags.push("debugging");
  if (/architect|reason|opus|sonnet|pro/.test(normalizedModel)) tags.push("architecture");
  if (/claude|sonnet|haiku/.test(normalizedModel)) tags.push("writing");
  if (/claude|sonnet|haiku|gpt-5|opus/.test(normalizedModel)) tags.push("emotional-nuance");
  if (/claude|sonnet|opus|grok-4|gpt-5|unified/.test(normalizedModel)) tags.push("conversational");
  if (/claude|sonnet|opus|grok-4|gpt-5/.test(normalizedModel)) tags.push("interpersonal");
  if (/claude|sonnet|opus|gpt-5/.test(normalizedModel)) tags.push("empathy");
  if (isVisionAnalysisModel(providerName, modelId)) tags.push("multimodal");
  if (supportsWebSearch(providerName, modelId)) tags.push("research");
  if (/opus|o3|codex|sonnet|pro|gpt-5/.test(normalizedModel)) tags.push("reflection");
  return Array.from(new Set(tags));
}

export function buildCandidateMetadata(
  providerName: ProviderName,
  modelId: string,
  intent: RequestIntent,
  options?: { registryLookup?: RegistryLookup }
): CandidateMetadata {
  const registry = lookupRegistryModel(options?.registryLookup, providerName, modelId);
  const normalizedModel = modelId.toLowerCase();
  const prior_score = rankModelForIntent(providerName, modelId, intent);
  const supportsVision = registry?.supports_vision ?? isVisionAnalysisModel(providerName, modelId);
  const supportsImageGeneration = registry?.supports_image_generation ?? isImageGenerationModel(providerName, modelId);
  const supportsVideo = registry?.supports_video ?? (providerName === "google" && normalizedModel.includes("gemini"));
  const reasoningDepth =
    registry?.reasoning_tier ??
    (/o3|opus|sonnet|codex|pro|gpt-5/.test(normalizedModel) ? "high" : /flash|mini|haiku/.test(normalizedModel) ? "low" : "medium");
  const speedTier =
    registry?.speed_tier ?? (/flash|mini|haiku|pulse/.test(normalizedModel) ? "fast" : /o3|opus/.test(normalizedModel) ? "slow" : "medium");
  const costTier = registry?.cost_tier ?? (/flash|mini|haiku/.test(normalizedModel) ? "low" : /o3|opus|pro/.test(normalizedModel) ? "high" : "medium");

  return {
    providerName,
    modelId,
    supports_text: registry?.supports_text ?? !supportsImageGeneration,
    supports_web_search: registry?.supports_web_search ?? supportsWebSearch(providerName, modelId),
    supports_vision: supportsVision,
    supports_video: supportsVideo,
    supports_image_generation: supportsImageGeneration,
    reasoning_depth_tier: reasoningDepth,
    speed_tier: speedTier,
    cost_tier: costTier,
    specialization_tags: detectSpecializationTags(providerName, modelId),
    prior_score
  };
}

export function buildRoutingPreferenceProfile(): RoutingPreferenceProfile {
  return {
    prioritize_best_model_for_task: true,
    quality_over_cost_for: [
      "assistant-reflection",
      "architecture-review",
      "code-review",
      "technical-debugging",
      "multimodal-reasoning",
      "social-emotional"
    ],
    prefer_efficient_for: ["general-text", "text", "rewrite", "news-summary", "web-search"],
    use_specialization_when_relevant: true,
    avoid_cost_or_speed_dominance_for_depth_tasks: true,
    hard_constraints_are_non_negotiable: true
  };
}

export function scoreModelCandidateWithBreakdown(
  providerName: ProviderName,
  modelId: string,
  intent: RequestIntent,
  options?: { registryLookup?: RegistryLookup }
): CandidateScoreBreakdown {
  const normalizedModel = modelId.toLowerCase();
  const adjustments: ScoreAdjustment[] = [];

  const finalize = (baseScore: number | null, finalScore: number, exclusionReason: string | null): CandidateScoreBreakdown => ({
    providerName,
    modelId,
    baseScore,
    adjustments,
    finalScore,
    excluded: finalScore < 0,
    exclusionReason: exclusionReason ?? (finalScore < 0 ? "score_below_zero" : null)
  });

  switch (intent) {
    case "image-generation": {
      if (!isImageGenerationModel(providerName, modelId)) {
        return finalize(null, -1, "intent_mismatch:image-generation");
      }
      const baseScore = normalizedModel.includes("banana") ? 4 : 2;
      return finalize(baseScore, baseScore, null);
    }
    case "multimodal-reasoning": {
      if (!modelSupportsIntent(providerName, modelId, intent, options?.registryLookup)) {
        return finalize(null, -1, "intent_mismatch:multimodal-reasoning");
      }
      const baseScore = 1;
      if (
        normalizedModel.includes("gpt-5") ||
        normalizedModel.includes("gpt-4o") ||
        normalizedModel.includes("claude-4.5") ||
        normalizedModel.includes("claude-4.6") ||
        normalizedModel.includes("o3")
      ) {
        adjustments.push({ label: "frontier_multimodal_bonus", delta: 4 });
      } else if (normalizedModel.includes("pro") && normalizedModel.includes("vision")) {
        adjustments.push({ label: "vision_pro_bonus", delta: 4 });
      } else if (normalizedModel.includes("pro")) {
        adjustments.push({ label: "pro_bonus", delta: 3 });
      } else if (normalizedModel.includes("flash")) {
        adjustments.push({ label: "flash_bonus", delta: 2 });
      }
      const finalScore = baseScore + adjustments.reduce((total, current) => total + current.delta, 0);
      return finalize(baseScore, finalScore, null);
    }
    case "vision-analysis": {
      if (!modelSupportsIntent(providerName, modelId, intent, options?.registryLookup)) {
        return finalize(null, -1, "intent_mismatch:vision-analysis");
      }
      const baseScore = 1;
      if (
        normalizedModel.includes("gpt-5") ||
        normalizedModel.includes("gpt-4o") ||
        normalizedModel.includes("claude-4.5") ||
        normalizedModel.includes("claude-4.6") ||
        normalizedModel.includes("o3")
      ) {
        adjustments.push({ label: "frontier_vision_bonus", delta: 4 });
      } else if (normalizedModel.includes("vision")) {
        adjustments.push({ label: "vision_bonus", delta: 4 });
      } else if (normalizedModel.includes("pro")) {
        adjustments.push({ label: "pro_bonus", delta: 3 });
      } else if (normalizedModel.includes("flash")) {
        adjustments.push({ label: "flash_bonus", delta: 2 });
      }
      const finalScore = baseScore + adjustments.reduce((total, current) => total + current.delta, 0);
      return finalize(baseScore, finalScore, null);
    }
    case "safety-sensitive-vision": {
      if (!modelSupportsIntent(providerName, modelId, intent, options?.registryLookup)) {
        return finalize(null, -1, "intent_mismatch:safety-sensitive-vision");
      }
      const baseScore = 1;
      if (normalizedModel.includes("vision")) {
        adjustments.push({ label: "vision_capability_bonus", delta: 4 });
      } else if (normalizedModel.includes("pro")) {
        adjustments.push({ label: "pro_bonus", delta: 3 });
      } else if (normalizedModel.includes("flash")) {
        adjustments.push({ label: "flash_bonus", delta: 2 });
      }
      if (providerName === "grok" && /reason|grok-4|grok-3/.test(normalizedModel)) {
        adjustments.push({ label: "safety_sensitive_vision_grok_boost", delta: 12 });
      }
      if (providerName === "openai" || providerName === "google") {
        adjustments.push({ label: "safety_sensitive_vision_filter_risk_penalty", delta: -8 });
      }
      const finalScore = baseScore + adjustments.reduce((total, current) => total + current.delta, 0);
      return finalize(baseScore, finalScore, null);
    }
    case "text":
    case "general-text":
    case "social-emotional":
    case "rewrite":
    case "emotional-analysis":
    case "news-summary":
    case "web-search": {
      if (!modelSupportsIntent(providerName, modelId, intent, options?.registryLookup)) {
        const reason = intent === "web-search" || intent === "news-summary" ? "missing_web_search_capability" : `intent_mismatch:${intent}`;
        return finalize(null, -1, reason);
      }
      const baseScore = 10;
      if (normalizedModel.includes("flash") || normalizedModel.includes("haiku") || normalizedModel.includes("mini")) {
        adjustments.push({ label: "speed_efficiency_bonus", delta: 4 });
      }
      if (normalizedModel.includes("gpt-5.2-unified") || normalizedModel.includes("grok-2-1212")) {
        adjustments.push({ label: "preferred_general_model_bonus", delta: 6 });
      }
      if (normalizedModel.includes("unified") || normalizedModel.includes("grok-2")) {
        adjustments.push({ label: "general_conversation_bonus", delta: 3 });
      }
      if (
        normalizedModel.includes("opus") ||
        normalizedModel.includes("o3-pro") ||
        normalizedModel.includes("codex") ||
        normalizedModel.includes("architect") ||
        normalizedModel.includes("reason")
      ) {
        adjustments.push({ label: "deep_reasoning_penalty", delta: -8 });
      }
      if (normalizedModel.includes("pro") && !normalizedModel.includes("gpt-5.2-unified")) {
        adjustments.push({ label: "pro_model_penalty", delta: -4 });
      }
      if (providerName === "anthropic" && (intent === "rewrite" || intent === "emotional-analysis")) {
        adjustments.push({ label: "claude_nuanced_writing_bonus", delta: 10 });
      }
      if (providerName === "grok" && (intent === "news-summary" || intent === "web-search")) {
        adjustments.push({ label: "grok_realtime_news_bonus", delta: 9 });
      }
      if (providerName === "google" && intent === "general-text") {
        adjustments.push({ label: "gemini_general_reasoning_bonus", delta: 4 });
      }
      if (intent === "social-emotional") {
        if (providerName === "anthropic") {
          adjustments.push({ label: "social_emotional_provider_bonus_anthropic", delta: 12 });
        } else if (providerName === "grok") {
          adjustments.push({ label: "social_emotional_provider_bonus_grok", delta: 10 });
        } else if (providerName === "openai") {
          adjustments.push({ label: "social_emotional_provider_bonus_openai", delta: 6 });
        } else if (providerName === "google") {
          adjustments.push({ label: "social_emotional_provider_penalty_google", delta: -6 });
        }
        if (normalizedModel.includes("flash") || normalizedModel.includes("lite") || normalizedModel.includes("mini")) {
          adjustments.push({ label: "social_emotional_small_fast_penalty", delta: -7 });
        }
        if (
          normalizedModel.includes("sonnet") ||
          normalizedModel.includes("opus") ||
          normalizedModel.includes("grok-4") ||
          normalizedModel.includes("gpt-5") ||
          normalizedModel.includes("unified")
        ) {
          adjustments.push({ label: "social_emotional_nuance_model_bonus", delta: 4 });
        }
      }
      if (intent === "web-search" && supportsWebSearch(providerName, modelId)) {
        adjustments.push({ label: "web_search_hard_requirement_met", delta: 3 });
      }
      const finalScore = baseScore + adjustments.reduce((total, current) => total + current.delta, 0);
      return finalize(baseScore, finalScore, null);
    }
    case "code-review":
    case "technical-debugging":
    case "architecture-review":
    case "code-generation": {
      if (isImageGenerationModel(providerName, modelId)) {
        return finalize(null, -1, "image_generation_model_excluded_for_technical_intent");
      }
      const baseScore = 10;
      if (normalizedModel.includes("codex") || normalizedModel.includes("o3-pro")) {
        adjustments.push({ label: "coding_reasoning_bonus", delta: 2 });
      }
      if (normalizedModel.includes("opus") || normalizedModel.includes("sonnet")) {
        adjustments.push({ label: "architecture_depth_bonus", delta: 1.5 });
      }
      if (normalizedModel.includes("pro")) {
        adjustments.push({ label: "pro_bonus", delta: 1 });
      }
      if (normalizedModel.includes("gpt-5") || normalizedModel.includes("gpt-4.1")) {
        adjustments.push({ label: "latest_gpt_bonus", delta: 1 });
      }
      if (normalizedModel.includes("mini") || normalizedModel.includes("flash") || normalizedModel.includes("haiku")) {
        adjustments.push({ label: "small_model_penalty", delta: -1 });
      }
      if (normalizedModel.includes("pulse")) {
        adjustments.push({ label: "realtime_model_penalty", delta: -1.5 });
      }
      const finalScore = baseScore + adjustments.reduce((total, current) => total + current.delta, 0);
      return finalize(baseScore, finalScore, null);
    }
    case "assistant-reflection": {
      if (isImageGenerationModel(providerName, modelId)) {
        return finalize(null, -1, "image_generation_model_excluded_for_reflection_intent");
      }
      const baseScore = 10;
      if (
        normalizedModel.includes("opus") ||
        normalizedModel.includes("o3-pro") ||
        normalizedModel.includes("codex") ||
        normalizedModel.includes("sonnet") ||
        normalizedModel.includes("pro") ||
        normalizedModel.includes("gpt-5")
      ) {
        adjustments.push({ label: "quality_reflection_bonus", delta: 2 });
      }
      if (normalizedModel.includes("mini") || normalizedModel.includes("flash") || normalizedModel.includes("haiku")) {
        adjustments.push({ label: "small_model_reflection_penalty", delta: -1 });
      }
      const finalScore = baseScore + adjustments.reduce((total, current) => total + current.delta, 0);
      return finalize(baseScore, finalScore, null);
    }
  }
}

export function validateRoutingDecision(
  decision: RoutingChoice,
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  intent: RequestIntent,
  options?: { registryLookup?: RegistryLookup }
): { provider: LlmProvider; modelId: string; reasoning: string; changed: boolean } {
  if (["technical-debugging", "code-generation", "architecture-review", "code-review", "assistant-reflection"].includes(intent)) {
    availableByProvider = availableByProvider.map(({ provider, models }) => ({
      provider,
      models: models.filter((modelId) => !isImageGenerationModel(provider.name, modelId))
    }));
  }

  const selectedProvider = availableByProvider.find(({ provider }) => provider.name === decision.providerName);

  if (
    selectedProvider &&
    modelSupportsIntent(decision.providerName, decision.modelId, intent, options?.registryLookup) &&
    selectedProvider.models.includes(decision.modelId)
  ) {
    return {
      provider: selectedProvider.provider,
      modelId: decision.modelId,
      reasoning: `Validated ${decision.providerName}:${decision.modelId} for ${intent}.`,
      changed: false
    };
  }

  const compatibleChoices = scoreModelsForIntent(availableByProvider, intent, { registryLookup: options?.registryLookup });

  const fallback = compatibleChoices[0];

  if (fallback) {
    return {
      provider: fallback.provider,
      modelId: fallback.modelId,
      reasoning: `Rejected ${decision.providerName}:${decision.modelId} for ${intent}; fell back to ${fallback.provider.name}:${fallback.modelId}.`,
      changed: true
    };
  }

  const firstProvider = selectedProvider ?? availableByProvider[0];
  const modelId = selectedProvider?.models[0] ?? availableByProvider[0]?.models[0] ?? decision.modelId;

  return {
    provider: firstProvider.provider,
    modelId,
    reasoning: `No compatible model found for ${intent}; kept closest available ${firstProvider.provider.name}:${modelId}.`,
    changed: true
  };
}

export function filterCandidatesForIntent(
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  intent: RequestIntent,
  options?: { hasVideoInput?: boolean; registryLookup?: RegistryLookup }
): Array<{ provider: LlmProvider; models: string[] }> {
  const hasVideoInput = Boolean(options?.hasVideoInput);
  return availableByProvider
    .map(({ provider, models }) => {
      const scopedModels = models.filter((modelId) => {
        if (hasVideoInput && provider.name !== "google") {
          return false;
        }
        return modelSupportsIntent(provider.name, modelId, intent, options?.registryLookup);
      });
      return { provider, models: scopedModels };
    })
    .filter(({ models }) => models.length > 0);
}

export async function chooseRoutingWithLLM(args: {
  prompt: string;
  intent: RequestIntent;
  modalityFlags: RoutingModalityFlags;
  hardRouteContext: HardRouteContext;
  preferenceProfile: RoutingPreferenceProfile;
  candidates: CandidateMetadata[];
  decisionProviders?: DecisionProviderCandidate[];
  registryLookup?: RegistryLookup;
}): Promise<LlmRoutingResult> {
  if (args.candidates.length === 0) {
    return { accepted: false, reason: "no_candidates" };
  }
  const eligibleDecisionProviders =
    args.decisionProviders?.filter((candidate) =>
      isEligibleControlPlaneModel(candidate.provider.name, candidate.modelId, args.registryLookup)
    ) ?? [];
  if (!eligibleDecisionProviders.length) {
    return { accepted: false, reason: "no_decision_provider_available" };
  }
  const candidateKeySet = new Set(args.candidates.map((candidate) => `${candidate.providerName}:${candidate.modelId}`));
  const candidateList = args.candidates.map((candidate) => ({
    provider: candidate.providerName,
    model: candidate.modelId,
    supports_text: candidate.supports_text,
    supports_web_search: candidate.supports_web_search,
    supports_vision: candidate.supports_vision,
    supports_video: candidate.supports_video,
    supports_image_generation: candidate.supports_image_generation,
    reasoning_depth_tier: candidate.reasoning_depth_tier,
    speed_tier: candidate.speed_tier,
    cost_tier: candidate.cost_tier,
    specialization_tags: candidate.specialization_tags,
    prior_score: candidate.prior_score,
    score_breakdown: candidate.score_breakdown
  }));

  const systemPrompt = `
You are the primary model router.
Choose the best single candidate from the valid candidate list.
Return ONLY compact JSON:
{"selected":{"provider":"openai|google|grok|anthropic","model":"<model-id>"}}
Rules:
- selected must be one of the provided candidates.
- Hard rules and invalid candidates have already been filtered deterministically; treat them as fixed constraints.
- Use preference_profile and candidate metadata to choose the best fit for the actual task.
- Optimize tradeoffs among quality, reasoning depth, speed, cost, specialization, and modality fit.
- Use prior_score only as advisory guidance; do not blindly choose the highest prior_score.
- If another candidate is clearly better for the task, choose it even when prior_score is lower.
- Respect explicit provider preferences only when clearly requested.
- Do not include markdown or any non-JSON text.
`.trim();

  const result = await executeControlPlaneJsonTask({
    taskName: "routing-rerank",
    decisionProviders: eligibleDecisionProviders,
    userPrompt: `${systemPrompt}\n\n${JSON.stringify({
      prompt: args.prompt,
      intent: args.intent,
      modality_flags: args.modalityFlags,
      hard_route_context: args.hardRouteContext,
      preference_profile: args.preferenceProfile,
      candidates: candidateList
    })}`,
    parse: (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        return null;
      }
      const parsed = JSON.parse(extractJsonObject(trimmed) ?? trimmed) as Record<string, unknown>;
      const selectedObject =
        parsed && typeof parsed.selected === "object" && parsed.selected !== null
          ? (parsed.selected as Record<string, unknown>)
          : null;
      const selectedProviderRaw = typeof selectedObject?.provider === "string" ? selectedObject.provider.trim().toLowerCase() : "";
      const selectedModel = typeof selectedObject?.model === "string" ? selectedObject.model.trim() : "";
      const selectedProvider = isProviderName(selectedProviderRaw) ? selectedProviderRaw : null;
      if (!selectedProvider || !selectedModel || !candidateKeySet.has(`${selectedProvider}:${selectedModel}`)) {
        return null;
      }
      return { selectedProvider, selectedModel };
    },
    timeoutMs: CONTROL_PLANE_DECISION_TIMEOUT_MS
  });
  if (!result) {
    return { accepted: false, reason: "all_decision_providers_failed" };
  }

  const ranking = args.candidates.map((candidate) => ({
    providerName: candidate.providerName,
    modelId: candidate.modelId,
    score: candidate.prior_score
  }));

  return {
    accepted: true,
    selected: { providerName: result.result.selectedProvider, modelId: result.result.selectedModel },
    ranking
  };
}
