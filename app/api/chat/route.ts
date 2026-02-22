// app/api/chat/route.ts
import { OpenAIStream, StreamingTextResponse } from 'ai';
import { OpenAI } from 'openai';
import { list, put } from '@vercel/blob';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  const { prompt, actorId, chatId, messages } = await req.json();

  // FIX: Dynamically find the blob URLs instead of hardcoding [your-id]
  const { blobs } = await list({ prefix: `chats/${actorId}/${chatId}.json`, access: 'private' });
  const actorList = await list({ prefix: `actors/${actorId}.json`, access: 'private' });

  if (blobs.length === 0 || actorList.length === 0) return new Response("Not Found", { status: 404 });

  const chatData = await (await fetch(blobs[0].url)).json();
  const actorData = await (await fetch(actorList[0].url)).json();

  // FIX: Use the Master Router model from your Env Variables
  const modelToUse = process.env.MASTER_ROUTER_MODEL || 'gpt-4o';

  const response = await openai.chat.completions.create({
    model: modelToUse,
    stream: true,
    messages: [
      { role: 'system', content: `PURPOSE: ${actorData.systemPurpose}\nSUMMARY: ${chatData.intermediarySummary}` },
      ...messages.slice(-15),
      { role: 'user', content: prompt }
    ],
  });

  const stream = OpenAIStream(response, {
    onCompletion: async (completion) => {
      const updatedHistory = [...chatData.history, { role: 'user', content: prompt }, { role: 'assistant', content: completion }];
      // FIX: Ensure access is 'private'
      await put(`chats/${actorId}/${chatId}.json`, JSON.stringify({ ...chatData, history: updatedHistory }), {
        access: 'private', 
        addRandomSuffix: false,
      });
    }
  });

  return new StreamingTextResponse(stream);
}
