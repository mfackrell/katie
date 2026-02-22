import { OpenAIStream, StreamingTextResponse } from 'ai'; // Helper from Vercel AI SDK
import { OpenAI } from 'openai';
import { put } from '@vercel/blob';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  const { prompt, actorId, chatId, messages } = await req.json();

  // 1. Fetch the Actor & Chat data from Vercel Blob
  const chatUrl = `https://[your-id].public.blob.vercel-storage.com/chats/${actorId}/${chatId}.json`;
  const actorUrl = `https://[your-id].public.blob.vercel-storage.com/actors/${actorId}.json`;
  
  const [chatRes, actorRes] = await Promise.all([fetch(chatUrl), fetch(actorUrl)]);
  const chatData = await chatRes.json();
  const actorData = await actorRes.json();

  // 2. The Master Router Decision (Simple Version)
  // Logic: Use GPT-4o for complex logic, Gemini for long-context creative tasks
  const selectedModel = prompt.length > 500 ? 'gemini-1.5-pro' : 'gpt-4o';

  // 3. Assemble the "Tri-Layer" Context
  const fullContext = [
    { role: 'system', content: `PURPOSE: ${actorData.systemPurpose}\nSUMMARY: ${chatData.intermediarySummary}` },
    ...messages.slice(-15), // Ephemeral Layer (Last 15 messages)
    { role: 'user', content: prompt }
  ];

  // 4. Request Stream
  const response = await openai.chat.completions.create({
    model: selectedModel,
    stream: true,
    messages: fullContext,
  });

  const stream = OpenAIStream(response, {
    onCompletion: async (completion) => {
      // 5. UPDATE BLOB IN BACKGROUND: Save new message to history
      const updatedHistory = [...chatData.history, { role: 'user', content: prompt }, { role: 'assistant', content: completion }];
      await put(`chats/${actorId}/${chatId}.json`, JSON.stringify({ ...chatData, history: updatedHistory }), {
        access: 'public', addRandomSuffix: false, contentType: 'application/json',
      });
    }
  });

  return new StreamingTextResponse(stream);
}
