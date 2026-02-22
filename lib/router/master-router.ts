import { generateObject } from 'ai';
import { z } from 'zod';
import { discoverModels, resolveModel } from '@/lib/providers';
import type { ModelDefinition } from '@/lib/providers/types';

const routeSchema = z.object({
  provider: z.enum(['openai', 'google']),
  modelId: z.string(),
  reason: z.string()
});

function manualOverride(prompt: string, models: ModelDefinition[]) {
  const normalized = prompt.toLowerCase();
  return models.find((model) => normalized.includes(model.modelId.toLowerCase()));
}

export async function pickModel(prompt: string) {
  const models = await discoverModels();
  const override = manualOverride(prompt, models);
  if (override) {
    return {
      selection: override,
      reason: `Manual override matched model keyword: ${override.modelId}`
    };
  }

  const routerModel = resolveModel('openai', process.env.MASTER_ROUTER_MODEL ?? 'gpt-4o-mini');
  const { object } = await generateObject({
    model: routerModel,
    schema: routeSchema,
    prompt: `Choose best model for this user prompt.\n\nPrompt: ${prompt}\n\nModels:\n${models
      .map((m) => `- ${m.provider}:${m.modelId} => ${m.useCase}`)
      .join('\n')}`
  });

  const selected =
    models.find((model) => model.provider === object.provider && model.modelId === object.modelId) ?? models[0];

  return {
    selection: selected,
    reason: object.reason
  };
}
