import {
  isImageGenerationModel as isGoogleImageGenerationModel,
  isVisionAnalysisModel as isGoogleVisionAnalysisModel
} from "@/lib/providers/google-model-capabilities";
import { LlmProvider } from "@/lib/providers/types";
type OpenAIClient = import("openai").default;

export type ProviderName = "openai" | "google" | "grok" | "anthropic";
export type RoutingChoice = { providerName: ProviderName; modelId: string };
export type LlmRoutingChoice = { providerName: ProviderName; modelId: string; score: number };
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
  if (normalizedPrompt.includes("claude") && providerName === "anthropic") {
    return 5;
  }
  if (normalizedPrompt.includes("gemini") && providerName === "google") {
    return 5;
  }
  if (normalizedPrompt.includes("grok") && providerName === "grok") {
    return 5;
  }
  if ((normalizedPrompt.includes("gpt") || normalizedPrompt.includes("chatgpt")) && providerName === "openai") {
    return 5;
  }
  return 0;
}

async function classifyIntentWithLLM(prompt: string, intents: RequestIntent[]): Promise<RequestIntent | null> {
  const openaiClientResult = await getOpenAIClient();
  if (!openaiClientResult.client) {
    if (openaiClientResult.reason === "missing_key") {
      console.warn("[Intent Classifier] OPENAI_API_KEY is not configured. Falling back to heuristic defaults.");
    } else {
      console.warn(
        "[Intent Classifier] OpenAI client initialization failed. Falling back to heuristic defaults.",
        openaiClientResult.error
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

    let classifiedIntent: string | null = null;

    try {
      const parsed = JSON.parse(raw);
      classifiedIntent = (parsed.intent ?? "").trim().toLowerCase();
    } catch (err) {
      console.error("[Intent Classifier] JSON parse error", err);
    }

    if (intents.includes(classifiedIntent as RequestIntent)) {
      return classifiedIntent as RequestIntent;
    }

    if (classifiedIntent === "null") {
      console.warn("[Intent Classifier] model returned null");
      return null;
    }

    console.warn(`[Intent Classifier] invalid intent "${classifiedIntent}"`);
    return null;
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

export async function inferRequestIntent(
  prompt: string,
  input: boolean | { hasImages: boolean; hasVideoInput?: boolean },
): Promise<RequestIntent> {
  const hasImages = typeof input === "boolean" ? input : input.hasImages;
  const hasVideoInput = typeof input === "boolean" ? false : Boolean(input.hasVideoInput);
  const normalizedPrompt = prompt.toLowerCase();

  // 0. Hard rule: obvious links and video references should always route through web search.
  if (hasDirectWebSearchHint(prompt)) {
    return "web-search";
  }
  if (hasAssistantReflectionHint(prompt)) {
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
    return "safety-sensitive-vision";
  }
  if (hasImages && /\b(chart|trend|forecast|project|estimate)\b/i.test(normalizedPrompt)) {
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
    return classifiedIntent;
  }

  if (hasImages) {
    return "vision-analysis";
  }
  if (hasVideoInput) {
    return "vision-analysis";
  }

  return "general-text";
}


function modelSupportsIntent(providerName: ProviderName, modelId: string, intent: RequestIntent): boolean {
  switch (intent) {
    case "web-search":
    case "news-summary":
      return !isImageGenerationModel(providerName, modelId) && supportsWebSearch(providerName, modelId);
    case "image-generation":
      return isImageGenerationModel(providerName, modelId);
    case "safety-sensitive-vision":
    case "vision-analysis":
    case "multimodal-reasoning":
      return isVisionAnalysisModel(providerName, modelId) && !isImageGenerationModel(providerName, modelId);
    case "text":
    case "general-text":
    case "rewrite":
    case "emotional-analysis":
    case "technical-debugging":
    case "architecture-review":
    case "code-generation":
    case "assistant-reflection":
      return !isImageGenerationModel(providerName, modelId);
  }
}

function rankTechnicalModel(providerName: ProviderName, modelId: string): number {
  if (isImageGenerationModel(providerName, modelId)) {
    return -1;
  }

  const normalizedModel = modelId.toLowerCase();
  let score = 10;

  if (normalizedModel.includes("codex") || normalizedModel.includes("o3-pro")) {
    score += 8;
  }
  if (normalizedModel.includes("opus") || normalizedModel.includes("sonnet")) {
    score += 6;
  }
  if (normalizedModel.includes("pro")) {
    score += 4;
  }
  if (normalizedModel.includes("gpt-5") || normalizedModel.includes("gpt-4.1")) {
    score += 4;
  }
  if (normalizedModel.includes("mini") || normalizedModel.includes("flash") || normalizedModel.includes("haiku")) {
    score -= 4;
  }
  if (normalizedModel.includes("pulse")) {
    score -= 6;
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
  prompt = ""
): Array<{ provider: LlmProvider; modelId: string; score: number }> {
  return availableByProvider
    .flatMap(({ provider, models }) =>
      models
        .map((modelId) => ({
          provider,
          modelId,
          score: rankModelForIntent(provider.name, modelId, intent) + userPreferredProviderBoost(prompt, provider.name)
        }))
        .filter((candidate) => candidate.score >= 0)
    )
    .sort((left, right) => right.score - left.score);
}

export function scoreModelCandidateWithBreakdown(
  providerName: ProviderName,
  modelId: string,
  intent: RequestIntent
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
      if (!modelSupportsIntent(providerName, modelId, intent)) {
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
      if (!modelSupportsIntent(providerName, modelId, intent)) {
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
      if (!modelSupportsIntent(providerName, modelId, intent)) {
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
      if (!modelSupportsIntent(providerName, modelId, intent)) {
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
        adjustments.push({ label: "coding_reasoning_bonus", delta: 8 });
      }
      if (normalizedModel.includes("opus") || normalizedModel.includes("sonnet")) {
        adjustments.push({ label: "architecture_depth_bonus", delta: 6 });
      }
      if (normalizedModel.includes("pro")) {
        adjustments.push({ label: "pro_bonus", delta: 4 });
      }
      if (normalizedModel.includes("gpt-5") || normalizedModel.includes("gpt-4.1")) {
        adjustments.push({ label: "latest_gpt_bonus", delta: 4 });
      }
      if (normalizedModel.includes("mini") || normalizedModel.includes("flash") || normalizedModel.includes("haiku")) {
        adjustments.push({ label: "small_model_penalty", delta: -4 });
      }
      if (normalizedModel.includes("pulse")) {
        adjustments.push({ label: "realtime_model_penalty", delta: -6 });
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
        adjustments.push({ label: "quality_reflection_bonus", delta: 8 });
      }
      if (normalizedModel.includes("mini") || normalizedModel.includes("flash") || normalizedModel.includes("haiku")) {
        adjustments.push({ label: "small_model_reflection_penalty", delta: -6 });
      }
      const finalScore = baseScore + adjustments.reduce((total, current) => total + current.delta, 0);
      return finalize(baseScore, finalScore, null);
    }
  }
}

export function validateRoutingDecision(
  decision: RoutingChoice,
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  intent: RequestIntent
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
    modelSupportsIntent(decision.providerName, decision.modelId, intent) &&
    selectedProvider.models.includes(decision.modelId)
  ) {
    return {
      provider: selectedProvider.provider,
      modelId: decision.modelId,
      reasoning: `Validated ${decision.providerName}:${decision.modelId} for ${intent}.`,
      changed: false
    };
  }

  const compatibleChoices = scoreModelsForIntent(availableByProvider, intent);

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

export async function chooseRoutingWithLLM(args: {
  prompt: string;
  intent: RequestIntent;
  candidates: LlmRoutingChoice[];
}): Promise<{ selected: RoutingChoice; ranking: LlmRoutingChoice[] } | null> {
  const openaiClientResult = await getOpenAIClient();
  if (!openaiClientResult.client) {
    if (openaiClientResult.reason === "missing_key") {
      console.warn("[Router LLM] OPENAI_API_KEY is not configured. Falling back to deterministic ranking.");
    } else {
      console.warn(
        "[Router LLM] OpenAI client initialization failed. Falling back to deterministic ranking.",
        openaiClientResult.error
      );
    }
    return null;
  }

  if (args.candidates.length === 0) {
    return null;
  }

  const openai = openaiClientResult.client;
  const candidateKeySet = new Set(args.candidates.map((candidate) => `${candidate.providerName}:${candidate.modelId}`));
  const candidateList = args.candidates.slice(0, 10).map((candidate) => ({
    provider: candidate.providerName,
    model: candidate.modelId,
    baselineScore: candidate.score
  }));

  const systemPrompt = `
You are a routing tie-breaker.
Choose at most one override candidate from the provided shortlist.
Return ONLY compact JSON:
{"selected":{"provider":"openai|google|grok|anthropic","model":"<model-id>"}}
Rules:
- selected must be one of the provided candidates.
- If uncertain, return {}.
- Do not include ranking or explanations.
- Respect explicit user provider preference words (claude/gemini/grok/gpt/chatgpt) unless capability mismatch.
- For assistant-reflection, prioritize response quality over cost/latency.
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
            candidates: candidateList
          })
        }
      ]
    });

    const raw = response.choices[0]?.message?.content ?? "";
    const rawPreview = raw.slice(0, 300).replace(/\s+/g, " ").trim();

    if (!raw.trim()) {
      console.warn("[Router LLM] Ignoring empty reranker response; falling back to deterministic ranking.");
      return null;
    }

    let parsed: { selected?: { provider?: string; model?: string } };
    try {
      parsed = JSON.parse(raw) as { selected?: { provider?: string; model?: string } };
    } catch {
      console.warn(
        `[Router LLM] Ignoring malformed reranker JSON; falling back to deterministic ranking. raw=${rawPreview || "<empty>"}`
      );
      return null;
    }

    const selectedProvider = (parsed.selected?.provider ?? "").trim().toLowerCase() as ProviderName;
    const selectedModel = (parsed.selected?.model ?? "").trim();

    if (!selectedProvider || !selectedModel || !candidateKeySet.has(`${selectedProvider}:${selectedModel}`)) {
      return null;
    }

    return {
      selected: { providerName: selectedProvider, modelId: selectedModel },
      ranking: args.candidates
    };
  } catch {
    console.warn("[Router LLM] Failed to get reranker override; falling back to deterministic ranking.");
    return null;
  }
}
