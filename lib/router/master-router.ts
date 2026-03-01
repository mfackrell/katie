import OpenAI from "openai";
import { LlmProvider } from "@/lib/providers/types";

export type RoutingDecision = {
  provider: LlmProvider;
  modelId: string;
  reasoning: string;
  routerModel: string;
};

type ProviderName = "openai" | "google" | "grok" | "anthropic";
type RoutingChoice = { providerName: ProviderName; modelId: string };

const ORCHESTRATOR_MODELS = ["gpt-5.2", "gemini-3.1-pro"] as const;
const DEFAULT_ORCHESTRATOR_MODEL = "gpt-5.2";

const CAPABILITY_REGISTRY: Record<string, string> = {
  "gpt-5.3-codex": "Agentic coding, tool use, APIs, terminal-style execution.",
  "o3-pro": "Deep reasoning, complex logic, math, high-accuracy thinking.",
  "grok-2-1212": "Balanced Grok default for general-purpose chat and reasoning tasks.",
  "o4-mini-high": "Fast reasoning; step-by-step logic at scale.",
  "gpt-5.2-unified": "Primary general conversation; balanced, reliable, fast.",
  "gpt-4o-data-extraction": "Strict JSON/schema extraction and SQL mapping.",
  "gpt-4o-audio": "Native audio processing; tone and sarcasm detection.",
  "gemini-3.1-pro": "Massive context leadership (2M+ tokens); complex doc/video analysis.",
  "gemini-3.1-flash": "Fast, cheap, high-volume simple tasks.",
  "gemini-3.1-flash-image-preview": "Nano Banana 2: High-efficiency SOTA model for image generation, high-fidelity asset creation, and 4K resolution support.",  
  "nano-banana-pro-preview": "Nano Banana Pro: The state-of-the-art model for high-fidelity image generation, professional asset creation, and precise visual reasoning.",
  "gemini-3.1-pro-vision": "Native video and advanced visual context analysis.",
  "gpt-image-1": "Secondary OpenAI image model.",
  "grok-4.1": "High-empathy, natural conversation, and leadership coaching. Anything sexual in nature that is not strictly educational. Unfiltered, rebellious, high-empathy, and edgy conversation. and any NSFW or adjacent text requests.",
  "grok-4-pulse": "Real-time news, social sentiment, and sub-second trends.",
  "claude-4.6-opus": "High Level System design, back end architecture, monolith-to-microservices migration, and multi-file refactoring.",
  "claude-4.5-sonnet": "Stable long-running autonomous workflows (30+ hours).",
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
    return models.find((model) => model.includes("gemini-3.1-pro-preview")) ?? models[0] ?? "gemini-3.1-pro-preview";
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
  providers: LlmProvider[]
): Promise<RoutingDecision> {
  const modelEntries = await Promise.all(
    providers.map(async (provider) => ({
      provider,
      models: await provider.listModels()
    }))
  );

  const availableByProvider = modelEntries.map(({ provider, models }) => ({
    provider,
    models: models.length ? models : [pickDefaultModel(provider, [])]
  }));

  if (availableByProvider.length === 1) {
    const selected = availableByProvider[0];
    const modelId = pickDefaultModel(selected.provider, selected.models);
    return {
      provider: selected.provider,
      modelId,
      reasoning: `Single provider available; selected default ${selected.provider.name}:${modelId}.`,
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
              "You are the Polyglot Actor Orchestrator. Your only job is to select the best model from the provided list based on the conversation context and the user's latest intent. Use the capability metadata below as your primary selection criteria, then constrain your final choice to the currently available model manifest.\n\All image requests must be routed to Google/Gemini models, never OpenAI models.\n\nCapability Registry:\n" +
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

            return {
              provider: selectedProvider.provider,
              modelId,
              reasoning: `Orchestrator selected ${parsedChoice.providerName}:${modelId}.`,
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

  const fallbackProvider = availableByProvider[0];
  const modelId = pickDefaultModel(fallbackProvider.provider, fallbackProvider.models);

  return {
    provider: fallbackProvider.provider,
    modelId,
    reasoning: `Fallback to ${fallbackProvider.provider.name}:${modelId} after routing unavailable or invalid.`,
    routerModel: modelId
  };
}
