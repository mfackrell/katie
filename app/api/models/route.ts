import { NextResponse } from 'next/server';
import { OpenAI } from 'openai';

type DiscoveredModel = {
  id: string;
  provider: 'OpenAI' | 'Google';
};

async function fetchOpenAIModels(): Promise<DiscoveredModel[]> {
  if (!process.env.OPENAI_API_KEY) {
    return [];
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.models.list();

  return response.data
    .filter((model) => model.id.includes('gpt') || model.id.includes('o1'))
    .map((model) => ({ id: model.id, provider: 'OpenAI' as const }));
}

async function fetchGeminiModels(): Promise<DiscoveredModel[]> {
  if (!process.env.GEMINI_API_KEY) {
    return [];
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`,
  );

  if (!response.ok) {
    throw new Error(`Gemini discovery failed (${response.status})`);
  }

  const data = (await response.json()) as { models?: Array<{ name?: string }> };

  return (data.models ?? [])
    .filter((model) => (model.name ?? '').toLowerCase().includes('gemini'))
    .map((model) => ({
      id: (model.name ?? '').split('/').pop() ?? '',
      provider: 'Google' as const,
    }))
    .filter((model) => Boolean(model.id));
}

export async function GET() {
  try {
    const [openaiModels, geminiModels] = await Promise.all([fetchOpenAIModels(), fetchGeminiModels()]);
    return NextResponse.json([...openaiModels, ...geminiModels]);
  } catch (error) {
    console.error('Model discovery error:', error);
    return NextResponse.json({ error: 'Failed to fetch model lists.' }, { status: 500 });
  }
}
