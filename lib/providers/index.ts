import type { ModelDefinition, ModelProvider, ProviderId } from '@/lib/providers/types';
import { googleProvider } from '@/lib/providers/google';
import { openAIProvider } from '@/lib/providers/openai';

const providers: Record<ProviderId, ModelProvider> = {
  openai: openAIProvider,
  google: googleProvider
};

export async function discoverModels(): Promise<ModelDefinition[]> {
  const all = await Promise.all(Object.values(providers).map((provider) => provider.listModels()));
  return all.flat();
}

export function resolveModel(provider: ProviderId, modelId: string) {
  return providers[provider].getModel(modelId);
}
