import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ModelDefinition, ModelProvider } from '@/lib/providers/types';

const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });

const GOOGLE_MODELS: ModelDefinition[] = [
  { provider: 'google', modelId: 'gemini-1.5-pro', useCase: 'long-context analysis and planning' },
  { provider: 'google', modelId: 'gemini-1.5-flash', useCase: 'fast drafting and lightweight tasks' }
];

export const googleProvider: ModelProvider = {
  async listModels() {
    return GOOGLE_MODELS;
  },
  getModel(modelId) {
    return google(modelId);
  }
};
