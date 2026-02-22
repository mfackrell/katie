// app/api/chat/route.ts
import { OpenAI } from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export async function POST(req: Request) {
  const { prompt, history, actorPurpose, intermediarySummary } = await req.json();

  // 1. Check for Manual Override
  const overrideModel = checkForOverride(prompt);
  let selectedModel;
  let reason = "User manual selection";

  if (overrideModel) {
    selectedModel = overrideModel;
  } else {
    // 2. The Decision Step (The "Master")
    // We use a cheap/fast model to decide the router logic
    const decision = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an LLM Router. Based on the user prompt and context, choose the best model. Return ONLY a JSON object: { 'provider': 'openai' | 'google', 'model': 'model-name', 'reason': 'short explanation' }" },
        { role: "user", content: `Prompt: ${prompt}\nContext: ${intermediarySummary}` }
      ],
      response_format: { type: "json_object" }
    });

    const choice = JSON.parse(decision.choices[0].message.content!);
    selectedModel = choice;
    reason = choice.reason;
  }

  // 3. Assemble the "Tri-Layer" Prompt
  const finalPrompt = `
    PERMANENT PURPOSE: ${actorPurpose}
    CONTEXT SUMMARY: ${intermediarySummary}
    RECENT HISTORY: ${JSON.stringify(history.slice(-10))}
    CURRENT REQUEST: ${prompt}
  `;

  // 4. Execute based on selection
  if (selectedModel.provider === 'openai') {
    return streamOpenAI(selectedModel.model, finalPrompt, reason);
  } else {
    return streamGemini(selectedModel.model, finalPrompt, reason);
  }
}

function checkForOverride(prompt: string) {
  if (prompt.toLowerCase().includes('/gpt4')) return { provider: 'openai', model: 'gpt-4o' };
  if (prompt.toLowerCase().includes('/gemini')) return { provider: 'google', model: 'gemini-1.5-pro' };
  return null;
}
