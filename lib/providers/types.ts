export interface FileReference {
  fileId: string;
  fileName: string;
  mimeType: string;
  preview: string;
  providerRef?: {
    openaiFileId?: string;
    googleFileUri?: string;
  };
}

export interface ChatGenerateParams {
  persona: string;
  summary: string;
  user: string;
  history: { role: "user" | "assistant"; content: string }[];
  modelId?: string;
  images?: string[];
  attachments?: FileReference[];
}

export interface ProviderResponse {
  text: string;
  model: string;
  provider: "openai" | "google" | "grok" | "anthropic";
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
  name: "openai" | "google" | "grok" | "anthropic";
  listModels(): Promise<string[]>;
  generate(params: ChatGenerateParams): Promise<ProviderResponse>;
}
