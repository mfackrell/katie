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
    return models.find((model) => model.includes("gemini-1.5-pro")) ?? models[0] ?? "gemini-1.5-pro";
  }

  return models.find((model) => model.includes("gpt-4o")) ?? models[0] ?? "gpt-4o";
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
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a routing model. Return only one option in the exact format provider:model from the allowed options. Prefer google for long-form synthesis and openai for coding/logic."
        },
        {
          role: "user",
          content: `Prompt: ${prompt}\nAllowed options: ${options}`
        }
      ]
    });

    const choice = completion.choices[0]?.message?.content?.trim().toLowerCase();
    if (choice) {
      const [providerName, ...modelParts] = choice.split(":");
      const modelId = modelParts.join(":");
      const selected = availableByProvider.find(
        ({ provider, models }) => provider.name === providerName && models.includes(modelId)
      );

      if (selected) {
        return [selected.provider, modelId];
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
