import OpenAI from "openai";
import { LlmProvider } from "@/lib/providers/types";

export type RoutingDecision = [LlmProvider, string];

const routingClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: globalThis.fetch.bind(globalThis) })
  : null;

function keywordOverride(prompt: string): "openai" | "google" | null {
  const lowered = prompt.toLowerCase();
  if (lowered.includes("use gpt") || lowered.includes("use openai")) {
    return "openai";
  }

  if (lowered.includes("use gemini") || lowered.includes("use google")) {
    return "google";
  }

  return null;
}

function pickDefaultModel(provider: LlmProvider, models: string[]): string {
  if (provider.name === "google") {
    return models.find((model) => model.includes("gemini-3.1-pro-preview")) ?? models[0] ?? "gemini-3.1-pro-preview";
  }

  return models.find((model) => model.includes("gpt-5.2")) ?? models[0] ?? "gpt-5.2";
}

function normalizeRoutingChoice(rawChoice: string): { providerName: "openai" | "google"; modelId: string } | null {
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

export async function chooseProvider(prompt: string, providers: LlmProvider[]): Promise<RoutingDecision> {
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

  const override = keywordOverride(prompt);
  if (override) {
    const selectedProvider = availableByProvider.find(({ provider }) => provider.name === override);
    if (selectedProvider) {
      return [
        selectedProvider.provider,
        pickDefaultModel(selectedProvider.provider, selectedProvider.models)
      ];
    }
  }

  if (availableByProvider.length === 1) {
    const selected = availableByProvider[0];
    return [selected.provider, pickDefaultModel(selected.provider, selected.models)];
  }

  if (routingClient) {
    const options = availableByProvider
      .flatMap(({ provider, models }) => models.map((model) => `${provider.name}:${model}`))
      .join(", ");

    const completion = await routingClient.chat.completions.create({
      model: "gpt-5.2",
      messages: [
        {
          role: "system",
          content:
            "You are a routing model. Return only one option in the exact format provider:model. You MUST ONLY select from the provided list of Allowed Options. Do not invent or guess new model versions."
        },
        {
          role: "user",
          content: `Prompt: ${prompt}\nAllowed options: ${options}`
        }
      ]
    });

    const choice = completion.choices[0]?.message?.content?.trim();
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

          return [selectedProvider.provider, modelId];
        }
      }
    }
  }

  const preferredProvider =
    prompt.length > 600
      ? availableByProvider.find(({ provider }) => provider.name === "google")
      : availableByProvider.find(({ provider }) => provider.name === "openai");

  const fallbackProvider = preferredProvider ?? availableByProvider[0];

  return [fallbackProvider.provider, pickDefaultModel(fallbackProvider.provider, fallbackProvider.models)];
}
