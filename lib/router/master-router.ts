import OpenAI from "openai";
import { inferRequestIntent, validateRoutingDecision } from "@/lib/router/model-intent";
import { LlmProvider } from "@/lib/providers/types";

export type RoutingDecision = {
  provider: LlmProvider;
  modelId: string;
  reasoning: string;
  routerModel: string;
};


const ORCHESTRATOR_MODELS = ["gpt-5", "gemini-pro-latest"] as const;
const DEFAULT_ORCHESTRATOR_MODEL = "gpt-5";
const BLOCKED_ROUTING_MODELS = new Set(["gpt-5.4-pro"]);

const CAPABILITY_REGISTRY: Record<string, string> = {
  "gpt-5.3-codex": "Agentic coding, tool use, APIs, terminal-style execution; ideal for math-heavy intents that must strictly follow MATH_EXECUTION_PROTOCOL via executable scripts.",
  "o3-pro": "Deep reasoning and complex logic; for math-heavy tasks it must strictly follow MATH_EXECUTION_PROTOCOL using executed scripts.",
  "grok-2-1212": "Balanced Grok default for general-purpose chat and reasoning tasks.",
  "o4-mini-high": "Fast reasoning; for math-heavy tasks it must strictly follow MATH_EXECUTION_PROTOCOL using executed scripts.",
  "gpt-5.2-unified": "Primary general conversation; balanced, reliable, fast; for math-heavy tasks it must strictly follow MATH_EXECUTION_PROTOCOL using executed scripts.",
  "gpt-4o-data-extraction": "Strict JSON/schema extraction and SQL mapping.",
  "gpt-4o-audio": "Native audio processing; tone and sarcasm detection.",
  "gemini-3.1-pro": "Massive context leadership (2M+ tokens); complex doc/video analysis; for math-heavy tasks it must strictly follow MATH_EXECUTION_PROTOCOL using executed scripts.",
  "gemini-3.1-flash": "Fast, cheap, high-volume simple tasks.",
  "gemini-3.1-flash-image-preview": "Nano Banana 2: High-efficiency SOTA model for image generation, high-fidelity asset creation, and 4K resolution support.",  
  "nano-banana-pro-preview": "Nano Banana Pro: The state-of-the-art model for high-fidelity image generation, professional asset creation, and precise visual reasoning.",
  "gemini-3.1-pro-vision": "Native video and advanced visual context analysis.",
  "gpt-image-1": "Secondary OpenAI image model.",
  "grok-4.1": "High-empathy, natural conversation, and leadership coaching. Unfiltered, rebellious, high-empathy, and edgy conversation.",
  "grok-4-pulse": "Real-time news, social sentiment, and sub-second trends.",
  "claude-4.6-opus": "High Level System design, back end architecture, monolith-to-microservices migration, and multi-file refactoring.",
  "claude-4.5-sonnet": "Stable long-running autonomous workflows (30+ hours); for math-heavy tasks it must strictly follow MATH_EXECUTION_PROTOCOL using executed scripts.",
  "claude-4.5-haiku": "Fast responses with strict brand-voice/style control."
};

function getOrchestratorModel(): (typeof ORCHESTRATOR_MODELS)[number] {
  const configuredModel = process.env.ROUTING_ORCHESTRATOR_MODEL;

  if (configuredModel && ORCHESTRATOR_MODELS.includes(configuredModel as (typeof ORCHESTRATOR_MODELS)[number])) {
    return configuredModel as (typeof ORCHESTRATOR_MODELS)[number];
  }

  return DEFAULT_ORCHESTRATOR_MODEL;
}


const routingClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: globalThis.fetch.bind(globalThis) })
  : null;

function pickDefaultModel(provider: LlmProvider, models: string[]): string {
  if (provider.name === "google") {
    return (
      models.find((model) => model === "gemini-3.1-pro") ??
      models.find((model) => model.includes("gemini-3.1-pro")) ??
      models[0] ??
      "gemini-3.1-pro"
    );
  }

  if (provider.name === "grok") {
    return models.find((model) => model.includes("grok-2-1212")) ?? models[0] ?? "grok-2-1212";
  }

  if (provider.name === "anthropic") {
    return (
      models.find((model) => model.includes("claude-4.5-sonnet")) ??
      models.find((model) => model.includes("claude")) ??
      models[0] ??
      "claude-4.5-sonnet"
    );
  }

  return models.find((model) => model.includes("gpt-5.2")) ?? models[0] ?? "gpt-5.2";
}

function normalizeRoutingChoice(rawChoice: string): RoutingChoice | null {
  const trimmedChoice = rawChoice.trim();

  if (trimmedChoice.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmedChoice) as { provider?: unknown; model?: unknown };
      const providerName = typeof parsed.provider === "string" ? parsed.provider.trim().toLowerCase() : null;
      const modelId = typeof parsed.model === "string" ? parsed.model.trim() : "";

      if ((providerName === "openai" || providerName === "google" || providerName === "grok" || providerName === "anthropic") && modelId) {
        return { providerName, modelId };
      }
    } catch {
      return null;
    }
  }

  const [providerNameRaw, ...modelParts] = rawChoice.split(":");
  const providerName = providerNameRaw?.trim().toLowerCase();

  if ((providerName !== "openai" && providerName !== "google" && providerName !== "grok" && providerName !== "anthropic") || modelParts.length === 0) {
    return null;
  }

  const modelId = modelParts.join(":").trim();
  if (!modelId) {
    return null;
  }

  return {
    providerName,
    modelId
  };
}

export async function chooseProvider(
  prompt: string,
  context: string,
  providers: LlmProvider[],
  options?: { hasImages?: boolean }
): Promise<RoutingDecision> {
  const modelEntries = await Promise.all(
    providers.map(async (provider) => ({
      provider,
      models: (await provider.listModels()).filter((modelId) => !BLOCKED_ROUTING_MODELS.has(modelId))
    }))
  );

  const availableByProvider = modelEntries.map(({ provider, models }) => ({
    provider,
    models: models.length ? models : [pickDefaultModel(provider, [])]
  }));

  const intent = inferRequestIntent(prompt, Boolean(options?.hasImages));

  if (availableByProvider.length === 1) {
    const selected = availableByProvider[0];
    const modelId = pickDefaultModel(selected.provider, selected.models);
    const validated = validateRoutingDecision({ providerName: selected.provider.name, modelId }, availableByProvider, intent);
    return {
      provider: validated.provider,
      modelId: validated.modelId,
      reasoning: `Single provider available. ${validated.reasoning}`,
      routerModel: modelId
    };
  }

  if (routingClient) {
    const options = availableByProvider
      .flatMap(({ provider, models }) => models.map((model) => `${provider.name}:${model}`))
      .join(", ");

    const manifest = availableByProvider
      .map(({ provider, models }) => `${provider.name}: ${models.join(", ")}`)
      .join("\n");

    try {
      const completion = await routingClient.responses.create({
        model: getOrchestratorModel(),
        input: [
          {
            role: "system",
            content:
              "You are the Polyglot Actor Orchestrator. Your only job is to select the best model from the provided list based on the conversation context and the user's latest intent. Use the capability metadata below as your primary selection criteria, then constrain your final choice to the currently available model manifest.\n\nAll image requests must be routed to Google/Gemini models, never OpenAI models.\nIf the user's intent is complex but OpenAI models have recently timed out or returned errors (as seen in context), you MUST route the request to a Google/Gemini model to ensure service continuity.\nFor complex mathematical, statistical, or logic-heavy intents, prioritize models with robust code-execution/tool-use capabilities and enforce strict adherence to MATH_EXECUTION_PROTOCOL.\n\nCapability Registry:\nIf the conversation context indicates 'Has Attached Images: true', you MUST route the request to a model capable of visual analysis, such as gemini-3.1-pro-vision. For requests explicitly asking to CREATE or GENERATE an image, prioritize Nano Banana models." +
              JSON.stringify(CAPABILITY_REGISTRY, null, 2) +
              "\n\nAvailable model manifest:\n" +
              manifest +
              "\n\nReturn only one selection as either a plain string in the exact format provider:model or strict JSON: {\"provider\":\"openai|google|grok|anthropic\",\"model\":\"model-id\"}. You MUST ONLY select from the manifest above."
          },
          {
            role: "user",
            content: `Conversation context:\n${context}\n\nLatest user intent:\n${prompt}\n\nAllowed options: ${options}`
          }
        ]
      });

      const choice = completion.output_text?.trim();
      if (choice) {
        const parsedChoice = normalizeRoutingChoice(choice);
        if (parsedChoice) {
          const selectedProvider = availableByProvider.find(
            ({ provider }) => provider.name === parsedChoice.providerName
          );

          if (selectedProvider) {
            const isAvailableModel = selectedProvider.models.includes(parsedChoice.modelId);
            const modelId = isAvailableModel
              ? parsedChoice.modelId
              : pickDefaultModel(selectedProvider.provider, selectedProvider.models);

            const validated = validateRoutingDecision({ providerName: parsedChoice.providerName, modelId }, availableByProvider, intent);
            return {
              provider: validated.provider,
              modelId: validated.modelId,
              reasoning: `Orchestrator selected ${parsedChoice.providerName}:${modelId}. ${validated.reasoning}`,
              routerModel: modelId
            };
          }
        }
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[Router] Orchestrator routing failed: ${detail}`);
    }
  }

  const googleEntry = availableByProvider.find(({ provider }) => provider.name === "google");
  const fallbackProvider = googleEntry || availableByProvider[0];
  const modelId = pickDefaultModel(fallbackProvider.provider, fallbackProvider.models);

  const validated = validateRoutingDecision({ providerName: fallbackProvider.provider.name, modelId }, availableByProvider, intent);

  return {
    provider: validated.provider,
    modelId: validated.modelId,
    reasoning: `Fallback routing selected ${fallbackProvider.provider.name}:${modelId}. ${validated.reasoning}`,
    routerModel: modelId
  };
}
