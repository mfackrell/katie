// app/api/chat/route.ts
import { OpenAI } from 'openai';
import { list, put } from '@vercel/blob';

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
    access: 'private' as any,
  });
  const { blobs: actorBlobs } = await list({
    prefix: `actors/${actorId}.json`,
    access: 'private' as any,
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
    messages: [
      {
        role: 'system',
        content: `PURPOSE: ${actorData.systemPurpose}\nSUMMARY: ${chatData.intermediarySummary}`,
      },
      ...(messages ?? []).slice(-15),
      { role: 'user', content: prompt },
    ],
  });

  const encoder = new TextEncoder();
  let fullOutput = '';

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of completion) {
          const token = chunk.choices?.[0]?.delta?.content ?? '';
          if (!token) continue;
          fullOutput += token;
          controller.enqueue(encoder.encode(token));
        }

        const updatedHistory = [
          ...chatData.history,
          { role: 'user', content: prompt },
          { role: 'assistant', content: fullOutput },
        ];

        await put(`chats/${actorId}/${chatId}.json`, JSON.stringify({ ...chatData, history: updatedHistory }), {
          access: 'private' as any,
          addRandomSuffix: false,
          contentType: 'application/json',
        });

        controller.close();
      } catch (error) {
        console.error('Streaming chat error:', error);
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
