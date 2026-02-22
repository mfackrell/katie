import { LanguageModelV1 } from 'ai';

export type ProviderId = 'openai' | 'google';

export interface ModelDefinition {
  provider: ProviderId;
  modelId: string;
  useCase: string;
}

export interface ModelProvider {
  listModels(): Promise<ModelDefinition[]>;
  getModel(modelId: string): LanguageModelV1;
}
