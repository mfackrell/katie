import { NextResponse } from 'next/server';
import { OpenAI } from 'openai';

type DiscoveredModel = {
  id: string;
  provider: 'OpenAI' | 'Google';
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function GET() {
  try {
    const [openAIModels, geminiResponse] = await Promise.all([
      openai.models.list(),
      fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`),
    ]);

    if (!geminiResponse.ok) {
      throw new Error(`Gemini models request failed with status ${geminiResponse.status}`);
    }

    const geminiData = await geminiResponse.json();

    const openAiDiscovered: DiscoveredModel[] = openAIModels.data
      .filter((model) => model.id.includes('gpt-4') || model.id.includes('gpt-3.5'))
      .map((model) => ({ id: model.id, provider: 'OpenAI' }));

    const geminiDiscovered: DiscoveredModel[] = (geminiData.models ?? [])
      .filter((model: { name?: string }) => (model.name ?? '').includes('gemini'))
      .map((model: { name: string }) => ({
        id: model.name.split('/').pop() ?? model.name,
        provider: 'Google',
      }));

    return NextResponse.json([...openAiDiscovered, ...geminiDiscovered]);
  } catch (error) {
    console.error('Discovery Error:', error);
    return NextResponse.json({ error: 'Failed to fetch models' }, { status: 500 });
  }
}
