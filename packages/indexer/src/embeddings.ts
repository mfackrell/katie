import { blockUnaccountedPaidDispatch } from "../../../lib/standalone-accounting/unsupported";
import OpenAI from 'openai';

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

export class NoopEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly dim: number) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => Array.from({ length: this.dim }, () => 0));
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  constructor(apiKey: string, private model: string) {
    this.client = new OpenAI({ apiKey, maxRetries: 0 });
  }

  async embed(texts: string[]): Promise<number[][]> {
    blockUnaccountedPaidDispatch("Indexer embeddings");
    const response = await this.client.embeddings.create({ model: this.model, input: texts });
    return response.data.map((v) => v.embedding);
  }
}
