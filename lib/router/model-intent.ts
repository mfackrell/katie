import {
  isImageGenerationModel as isGoogleImageGenerationModel,
  isVisionAnalysisModel as isGoogleVisionAnalysisModel
} from "@/lib/providers/google-model-capabilities";
import { lookupRegistryModel, type RegistryRoutingModel } from "@/lib/models/registry";
import { LlmProvider } from "@/lib/providers/types";
type OpenAIClient = import("openai").default;

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
  | "rewrite"
  | "emotional-analysis"
  | "news-summary"
  | "web-search"
  | "technical-debugging"
  | "architecture-review"
  | "code-generation"
  | "assistant-reflection"
  | "safety-sensitive-vision"
  | "vision-analysis"
  | "multimodal-reasoning"
  | "image-generation";
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
const INTENT_CLASSIFICATION_MODEL_ID = "gpt-4o";

const intentDescriptions: Record<RequestIntent, string> = {
  text: "General text processing, base type.",
  "general-text":
    "For broad, non-specific questions or casual conversation where no other specific intent applies.",
  rewrite: "For rephrasing, editing, polishing, or adjusting the tone of text.",
  "emotional-analysis": "For analyzing sentiment, tone, feelings, or emotional nuance in text.",
  "news-summary": "For summarizing current events, headlines, or recent news.",
  "web-search": "For queries requiring up-to-date information, current events, or live data via a web search.",
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

let openaiClient: OpenAIClient | null | undefined;

function isProviderName(value: string): value is ProviderName {
  return value === "openai" || value === "google" || value === "grok" || value === "anthropic";
}

type OpenAIClientResult =
  | { client: OpenAIClient; reason: null }
  | { client: null; reason: "missing_key" }
  | { client: null; reason: "init_failed"; error: unknown };

async function getOpenAIClient(): Promise<OpenAIClientResult> {
  if (openaiClient) {
    return { client: openaiClient, reason: null };
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    openaiClient = null;
    return { client: null, reason: "missing_key" };
  }

  try {
    const { default: OpenAI } = await import("openai");
    openaiClient = new OpenAI({ apiKey });
    return { client: openaiClient, reason: null };
  } catch (error) {
    openaiClient = null;
    return { client: null, reason: "init_failed", error };
  }
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

export function userPreferredProviderBoost(prompt: string, providerName: ProviderName): number {
  const normalizedPrompt = prompt.toLowerCase();
  const explicitPreferencePatterns: Array<{ providerName: ProviderName; pattern: RegExp }> = [
    { providerName: "anthropic", pattern: /\b(use|route to|pick|choose|prefer)\s+(claude|anthropic)\b/i },
    { providerName: "google", pattern: /\b(use|route to|pick|choose|prefer)\s+(gemini|google)\b/i },
    { providerName: "grok", pattern: /\b(use|route to|pick|choose|prefer)\s+grok\b/i },
    { providerName: "openai", pattern: /\b(use|route to|pick|choose|prefer)\s+(gpt|chatgpt|openai)\b/i }
  ];

  const matchedExplicitPreference = explicitPreferencePatterns.find(
    (candidate) => candidate.providerName === providerName && candidate.pattern.test(normalizedPrompt)
  );
  if (matchedExplicitPreference) {
    return 1.5;
  }

  return 0;
}

function parseIntentClassifierResponse(raw: string, intents: RequestIntent[], sourceLabel: string): RequestIntent | null {
  let classifiedIntent: string | null = null;

  try {
    const parsed = JSON.parse(raw);
    classifiedIntent = (parsed.intent ?? "").trim().toLowerCase();
  } catch (err) {
    console.error(`[Intent Classifier:${sourceLabel}] JSON parse error`, err);
    return null;
  }

  if (intents.includes(classifiedIntent as RequestIntent)) {
    return classifiedIntent as RequestIntent;
  }

  if (classifiedIntent === "null") {
    console.warn(`[Intent Classifier:${sourceLabel}] model returned null`);
    return null;
  }

  console.warn(`[Intent Classifier:${sourceLabel}] invalid intent "${classifiedIntent}"`);
  return null;
}

async function classifyIntentWithLLM(prompt: string, intents: RequestIntent[]): Promise<RequestIntent | null> {
  const openaiClientResult = await getOpenAIClient();
  if (!openaiClientResult.client) {
    if (openaiClientResult.reason === "missing_key") {
      console.warn("[Intent Classifier] OPENAI_API_KEY is not configured. Falling back to heuristic defaults.");
    } else {
      console.warn(
        "[Intent Classifier] OpenAI client initialization failed. Falling back to heuristic defaults.",
        "error" in openaiClientResult ? openaiClientResult.error : null
      );
    }
    return null;
  }

  const openai = openaiClientResult.client;

  const intentGuide = intents.map((intent) => `- ${intent}: ${intentDescriptions[intent]}`).join("\n");
  const examples = [
    { user: "Rewrite this paragraph in a friendly tone.", intent: "rewrite" },
    { user: "Summarise today’s NYT front page.", intent: "news-summary" },
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
You are an expert intent classifier.
First you will examine the request and if you determine there is a high likelyhood that it will trigger openai safety filter, if so immediately route the request to a grok reasoning model. if not proceed with your classification task.
Return ONLY a JSON object like {"intent":"<one_of:${intents.join("|")}>"}.
If unsure use {"intent":"null"}.
No other keys.
${intentGuide}
  `.trim();
  const messages = [
    { role: "system" as const, content: systemPrompt },
    ...examples.flatMap((example) => [
      { role: "user" as const, content: example.user },
      { role: "assistant" as const, content: JSON.stringify({ intent: example.intent }) }
    ]),
    { role: "user" as const, content: prompt }
  ];

  try {
    const llmResponse = await openai.chat.completions.create({
      model: INTENT_CLASSIFICATION_MODEL_ID,
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 100,
      messages
    });

    const raw = llmResponse.choices[0]?.message?.content ?? "";
    console.debug("[Intent Classifier] raw model output:", raw);

    return parseIntentClassifierResponse(raw, intents, "text-llm");
  } catch (error) {
    const err = error as {
      message?: string;
      status?: number;
      code?: string;
      type?: string;
      param?: string;
      request_id?: string;
    };

    console.error("[Intent Classifier] Failed to classify request intent", {
      message: err?.message ?? "Unknown error",
      status: err?.status ?? null,
      code: err?.code ?? null,
      type: err?.type ?? null,
      param: err?.param ?? null,
      request_id: err?.request_id ?? null
    });

    return null;
  }
}



export async function inferRequestIntentFromMultimodalInput(
  prompt: string,
  images: string[],
  intents: RequestIntent[] = [
    "web-search",
    "news-summary",
    "emotional-analysis",
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

  const openaiClientResult = await getOpenAIClient();
  if (!openaiClientResult.client) {
    if (openaiClientResult.reason === "missing_key") {
      console.warn("[Intent Classifier:multimodal] OPENAI_API_KEY is not configured.");
    } else {
      console.warn("[Intent Classifier:multimodal] OpenAI client initialization failed.", "error" in openaiClientResult ? openaiClientResult.error : null);
    }

    return null;
  }

  const openai = openaiClientResult.client;
  const intentGuide = intents.map((intent) => `- ${intent}: ${intentDescriptions[intent]}`).join("\n");

  try {
    const response = await openai.chat.completions.create({
      model: INTENT_CLASSIFICATION_MODEL_ID,
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 100,
      messages: [
        {
          role: "system",
          content: [
            "You classify request intent only.",
            `Return strict JSON only: {\"intent\":\"<one_of:${intents.join("|")}>\"}.`,
            'If uncertain, return {"intent":"null"}.',
            "Never choose a provider or model.",
            "Use image content plus user text, with special care for safety-sensitive-vision when the request seeks explicit sexual interpretation or has likely provider filtering risk.",
            intentGuide
          ].join("\n")
        },
        {
          role: "user",
          content: [
            { type: "text", text: `User prompt:\n${prompt}` },
            ...images.slice(0, 4).map((url) => ({
              type: "image_url" as const,
              image_url: { url }
            }))
          ]
        }
      ]
    });

    const raw = response.choices[0]?.message?.content ?? "";
    console.debug("[Intent Classifier:multimodal] raw model output:", raw);
    return parseIntentClassifierResponse(raw, intents, "multimodal");
  } catch (error) {
    const err = error as {
      message?: string;
      status?: number;
      code?: string;
      type?: string;
      param?: string;
      request_id?: string;
    };

    console.error("[Intent Classifier:multimodal] Failed to classify request intent", {
      message: err?.message ?? "Unknown error",
      status: err?.status ?? null,
      code: err?.code ?? null,
      type: err?.type ?? null,
      param: err?.param ?? null,
      request_id: err?.request_id ?? null
    });

    return null;
  }
}

export async function inferRequestIntent(
  prompt: string,
  input: boolean | { hasImages: boolean; hasVideoInput?: boolean },
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
    "emotional-analysis",
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

  const classifiedIntent = await classifyIntentWithLLM(prompt, availableIntents);

  if (classifiedIntent && availableIntents.includes(classifiedIntent)) {
    console.info(`[Intent Source] text LLM classifier -> ${classifiedIntent}`);
    return classifiedIntent;
  }

  if (hasImages) {
    console.info("[Intent Source] fallback path -> vision-analysis");
    return "vision-analysis";
  }
  if (hasVideoInput) {
    return "vision-analysis";
  }

  console.info("[Intent Source] fallback path -> general-text");
  return "general-text";
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

      return score;
    case "technical-debugging":
    case "architecture-review":
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
  prompt = "",
  options?: { registryLookup?: RegistryLookup }
): Array<{ provider: LlmProvider; modelId: string; score: number }> {
  return availableByProvider
    .flatMap(({ provider, models }) =>
      models
        .map((modelId) => ({
          provider,
          modelId,
          score: rankModelForIntent(provider.name, modelId, intent) + userPreferredProviderBoost(prompt, provider.name)
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
    quality_over_cost_for: ["assistant-reflection", "architecture-review", "technical-debugging", "multimodal-reasoning"],
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
      if (intent === "web-search" && supportsWebSearch(providerName, modelId)) {
        adjustments.push({ label: "web_search_hard_requirement_met", delta: 3 });
      }
      const finalScore = baseScore + adjustments.reduce((total, current) => total + current.delta, 0);
      return finalize(baseScore, finalScore, null);
    }
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
  if (["technical-debugging", "code-generation", "architecture-review", "assistant-reflection"].includes(intent)) {
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

  const compatibleChoices = scoreModelsForIntent(availableByProvider, intent, "", { registryLookup: options?.registryLookup });

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
}): Promise<LlmRoutingResult> {
  const openaiClientResult = await getOpenAIClient();
  if (!openaiClientResult.client) {
    if (openaiClientResult.reason === "missing_key") {
      console.warn("[Router LLM] OPENAI_API_KEY is not configured. Falling back to deterministic ranking.");
    } else {
      console.warn(
        "[Router LLM] OpenAI client initialization failed. Falling back to deterministic ranking.",
        "error" in openaiClientResult ? openaiClientResult.error : null
      );
    }
    return { accepted: false, reason: `client_unavailable:${openaiClientResult.reason}` };
  }

  if (args.candidates.length === 0) {
    return { accepted: false, reason: "no_candidates" };
  }

  const openai = openaiClientResult.client;
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

  try {
    const response = await openai.chat.completions.create({
      model: INTENT_CLASSIFICATION_MODEL_ID,
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            prompt: args.prompt,
            intent: args.intent,
            modality_flags: args.modalityFlags,
            hard_route_context: args.hardRouteContext,
            preference_profile: args.preferenceProfile,
            candidates: candidateList
          })
        }
      ]
    });

    const raw = response.choices[0]?.message?.content ?? "";
    const rawPreview = raw.slice(0, 300).replace(/\s+/g, " ").trim();

    if (!raw.trim()) {
      console.warn("[Router LLM] Ignoring empty reranker response; falling back to deterministic ranking.");
      return { accepted: false, reason: "empty_response" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(
        `[Router LLM] Ignoring malformed reranker JSON; falling back to deterministic ranking. raw=${rawPreview || "<empty>"}`
      );
      return { accepted: false, reason: "malformed_json" };
    }

    const parsedObject = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    const selectedObject =
      parsedObject && typeof parsedObject.selected === "object" && parsedObject.selected !== null
        ? (parsedObject.selected as Record<string, unknown>)
        : null;

    const selectedProviderRaw = typeof selectedObject?.provider === "string" ? selectedObject.provider.trim().toLowerCase() : "";
    const selectedModel = typeof selectedObject?.model === "string" ? selectedObject.model.trim() : "";
    const selectedProvider = isProviderName(selectedProviderRaw) ? selectedProviderRaw : null;

    if (!selectedProvider || !selectedModel || !candidateKeySet.has(`${selectedProvider}:${selectedModel}`)) {
      return { accepted: false, reason: "invalid_or_out_of_pool_selection" };
    }

    const ranking = args.candidates.map((candidate) => ({
      providerName: candidate.providerName,
      modelId: candidate.modelId,
      score: candidate.prior_score
    }));

    return {
      accepted: true,
      selected: { providerName: selectedProvider, modelId: selectedModel },
      ranking
    };
  } catch {
    console.warn("[Router LLM] Failed to get reranker override; falling back to deterministic ranking.");
    return { accepted: false, reason: "completion_error" };
  }
}
