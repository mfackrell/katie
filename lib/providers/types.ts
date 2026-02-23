export interface ChatGenerateParams {
  system: string;
  user: string;
}

export interface ProviderResponse {
  text: string;
  model: string;
  provider: "openai" | "google";
}

export interface LlmProvider {
  name: "openai" | "google";
  listModels(): Promise<string[]>;
  generate(params: ChatGenerateParams): Promise<ProviderResponse>;
}
