import OpenAI from "openai";
import { LlmProvider } from "@/lib/providers/types";

export type RoutingDecision = {
  provider: LlmProvider;
  modelId: string;
  reasoning?: string;
};

type ProviderName = "openai" | "google";
type RoutingChoice = { providerName: ProviderName; modelId: string };

const ORCHESTRATOR_MODELS = ["gpt-5.2", "gemini-3.1-pro"] as const;
const DEFAULT_ORCHESTRATOR_MODEL = "gpt-5.2";

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

  return models.find((model) => model.includes("gpt-5.2")) ?? models[0] ?? "gpt-5.2";
}

function normalizeRoutingChoice(rawChoice: string): RoutingChoice | null {
  const trimmedChoice = rawChoice.trim();

  if (trimmedChoice.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmedChoice) as { provider?: unknown; model?: unknown };
      const providerName = typeof parsed.provider === "string" ? parsed.provider.trim().toLowerCase() : null;
      const modelId = typeof parsed.model === "string" ? parsed.model.trim() : "";

      if ((providerName === "openai" || providerName === "google") && modelId) {
        return { providerName, modelId };
      }
    } catch {
      return null;
    }
  }

  const [providerNameRaw, ...modelParts] = rawChoice.split(":");
  const providerName = providerNameRaw?.trim().toLowerCase();

  if ((providerName !== "openai" && providerName !== "google") || modelParts.length === 0) {
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
    return {
      provider: selected.provider,
      modelId: pickDefaultModel(selected.provider, selected.models),
      reasoning: "Single provider available; selected default model."
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
              "You are the Polyglot Actor Orchestrator. Your only job is to select the best model from the provided list based on the conversation context and the user's latest intent. Do not use heuristics; use your full reasoning capability.\n\nAvailable model manifest:\n" +
              manifest +
              "\n\nReturn only one selection as either a plain string in the exact format provider:model or strict JSON: {\"provider\":\"openai|google\",\"model\":\"model-id\"}. You MUST ONLY select from the manifest above."
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
              reasoning: `Orchestrator selected ${parsedChoice.providerName}:${parsedChoice.modelId}.`
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

  return {
    provider: fallbackProvider.provider,
    modelId: pickDefaultModel(fallbackProvider.provider, fallbackProvider.models),
    reasoning: "Fallback to first available provider/model after routing unavailable or invalid."
  };
}
