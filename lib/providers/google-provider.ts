import { ChatGenerateParams, LlmProvider, ProviderResponse } from "@/lib/providers/types";

export class GoogleProvider implements LlmProvider {
  name = "google" as const;
  private apiKey: string;
  private defaultModel = "gemini-1.5-pro";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async listModels(): Promise<string[]> {
    return ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash-exp"];
  }

  async generate(params: ChatGenerateParams): Promise<ProviderResponse> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.defaultModel}:generateContent?key=${this.apiKey}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `${params.system}\n\nUser request:\n${params.user}`
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini request failed (${response.status})`);
    }

    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    return {
      text,
      model: this.defaultModel,
      provider: this.name
    };
  }
}
