import { list, put } from '@vercel/blob';
import { OpenAI } from 'openai';
import { OpenAIStream, StreamingTextResponse } from 'ai';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function blobAuthHeaders() {
  return {
    Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
  };
}

export async function POST(req: Request) {
  const { actorId, chatId, messages } = (await req.json()) as {
    actorId?: string;
    chatId?: string;
    messages?: ChatMessage[];
  };

  if (!actorId || !chatId || !Array.isArray(messages) || messages.length === 0) {
    return new Response('Invalid request', { status: 400 });
  }

  const [chatListResult, actorListResult] = await Promise.all([
    list({ prefix: `chats/${actorId}/${chatId}.json` }),
    list({ prefix: `actors/${actorId}.json` }),
  ]);

  if (chatListResult.blobs.length === 0 || actorListResult.blobs.length === 0) {
    return new Response('Actor or chat not found', { status: 404 });
  }

  const [chatResponse, actorResponse] = await Promise.all([
    fetch(chatListResult.blobs[0].url, { headers: blobAuthHeaders() }),
    fetch(actorListResult.blobs[0].url, { headers: blobAuthHeaders() }),
  ]);

  if (!chatResponse.ok || !actorResponse.ok) {
    return new Response('Failed to load chat state', { status: 500 });
  }

  const chatData = await chatResponse.json();
  const actorData = await actorResponse.json();

  const ephemeralMessages = messages.slice(-15);
  const latestUserPrompt = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';

  const completion = await openai.chat.completions.create({
    model: process.env.MASTER_ROUTER_MODEL || 'gpt-4o',
    stream: true,
    messages: [
      {
        role: 'system',
        content: `PERMANENT_ACTOR_PURPOSE: ${actorData.systemPurpose}\nINTERMEDIARY_SUMMARY: ${chatData.intermediarySummary ?? ''}`,
      },
      ...ephemeralMessages,
    ],
  });

  const stream = OpenAIStream(completion as any, {
    onCompletion: async (assistantCompletion) => {
      const updatedHistory = [
        ...(chatData.history ?? []),
        { role: 'user', content: latestUserPrompt },
        { role: 'assistant', content: assistantCompletion },
      ];

      await put(
        `chats/${actorId}/${chatId}.json`,
        JSON.stringify({
          ...chatData,
          history: updatedHistory,
          updatedAt: new Date().toISOString(),
        }),
        {
          access: 'public',
          addRandomSuffix: false,
          contentType: 'application/json',
        },
      );
    },
  });

  return new StreamingTextResponse(stream);
}
