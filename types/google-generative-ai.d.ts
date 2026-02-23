declare module "@google/generative-ai" {
  export class GoogleGenerativeAI {
    constructor(apiKey: string);
    getGenerativeModel(params: { model: string; systemInstruction: string }): {
      generateContent(request: {
        contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
      }): Promise<{ response?: { text?: () => string } }>;
    };
    listModels?(): Promise<{ models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> } | Array<{ name?: string; supportedGenerationMethods?: string[] }>>;
  }
}
