// app/api/chat/route.ts
import { OpenAI } from 'openai';
import { list, put } from '@vercel/blob';
import { OpenAIStream, StreamingTextResponse } from 'ai'; // <--- Add this import

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function blobAuthHeaders() {
  return {
    Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
  };
}

export async function POST(req: Request) {
  const { prompt, actorId, chatId, messages } = await req.json();

  const { blobs } = await list({
    prefix: `chats/${actorId}/${chatId}.json`,
  });
  const { blobs: actorBlobs } = await list({
    prefix: `actors/${actorId}.json`,
  });

  if (blobs.length === 0 || actorBlobs.length === 0) {
    return new Response('Not Found', { status: 404 });
  }

  const chatRes = await fetch(blobs[0].url, { headers: blobAuthHeaders() });
  const actorRes = await fetch(actorBlobs[0].url, { headers: blobAuthHeaders() });

  if (!chatRes.ok || !actorRes.ok) {
    return new Response('Failed to read actor/chat state', { status: 500 });
  }

  const chatData = await chatRes.json();
  const actorData = await actorRes.json();

  const modelToUse = process.env.MASTER_ROUTER_MODEL || 'gpt-4o';

  const completion = await openai.chat.completions.create({
    model: modelToUse,
    stream: true, // 1. Add this
    messages: [
      {
        role: 'system',
        content: `PURPOSE: ${actorData.systemPurpose}\nSUMMARY: ${chatData.intermediarySummary}`,
      },
      ...(messages ?? []).slice(-15),
      { role: 'user', content: prompt },
    ],
  });

  const stream = OpenAIStream(completion, {
    onCompletion: async (text) => {
      const updatedHistory = [
        ...chatData.history,
        { role: 'user', content: prompt },
        { role: 'assistant', content: text },
      ];

      await put(`chats/${actorId}/${chatId}.json`, JSON.stringify({ ...chatData, history: updatedHistory }), {
        access: 'private' as any,
        addRandomSuffix: false,
        contentType: 'application/json',
      });
    },
  });

  return new StreamingTextResponse(stream); // 4. Replace your manual Response block with this
}
