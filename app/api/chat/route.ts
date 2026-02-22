// app/api/chat/route.ts
import { OpenAI } from 'openai';
import { list, put } from '@vercel/blob';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

  const chatData = await (await fetch(blobs[0].url)).json();
  const actorData = await (await fetch(actorBlobs[0].url)).json();

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

  const output = completion.choices[0]?.message?.content ?? '';

  const updatedHistory = [
    ...chatData.history,
    { role: 'user', content: prompt },
    { role: 'assistant', content: output },
  ];

  await put(`chats/${actorId}/${chatId}.json`, JSON.stringify({ ...chatData, history: updatedHistory }), {
    access: 'private' as any,
    addRandomSuffix: false,
    contentType: 'application/json',
  });

  return new Response(output, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
