import { createOpenAI } from '@ai-sdk/openai';
import type { ModelDefinition, ModelProvider } from '@/lib/providers/types';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const OPENAI_MODELS: ModelDefinition[] = [
  { provider: 'openai', modelId: 'gpt-4o', useCase: 'complex logic, coding, high precision tasks' },
  { provider: 'openai', modelId: 'gpt-4o-mini', useCase: 'cheap fast routing and summarization' }
];

export const openAIProvider: ModelProvider = {
  async listModels() {
    return OPENAI_MODELS;
  },
  getModel(modelId) {
    return openai(modelId);
  }
};
