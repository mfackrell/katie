export interface ChatGenerateParams {
  persona: string;
  summary: string;
  user: string;
  history: { role: "user" | "assistant"; content: string }[];
  modelId?: string;
}

export interface ProviderResponse {
  text: string;
  model: string;
  provider: "openai" | "google";
  content?: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    [key: string]: unknown;
  };
}

export interface LlmProvider {
  name: "openai" | "google";
  listModels(): Promise<string[]>;
  generate(params: ChatGenerateParams): Promise<ProviderResponse>;
}
