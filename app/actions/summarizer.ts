'use server';

import { put, list } from '@vercel/blob';
import { OpenAI } from 'openai';

const openai = new OpenAI();

export async function updateIntermediarySummary(actorId: string, chatId: string) {
  // Use list to find the authenticated, private URL dynamically
  const { blobs } = await list({
    prefix: `chats/${actorId}/${chatId}.json`,
    access: 'private' as any
  });

  if (blobs.length === 0) return;

  const response = await fetch(blobs[0].url, {
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }
  });
  if (!response.ok) return;

  const chatData = await response.json();

  if (chatData.history.length < 15) return;

  const messagesToSummarize = chatData.history.slice(0, 10);
  const remainingMessages = chatData.history.slice(10);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: `Update the summary. Retain key facts. Current: ${chatData.intermediarySummary}` },
      { role: 'user', content: JSON.stringify(messagesToSummarize) }
    ]
  });

  const updatedChatData = {
    ...chatData,
    intermediarySummary: completion.choices[0].message.content,
    history: remainingMessages,
  };

  await put(`chats/${actorId}/${chatId}.json`, JSON.stringify(updatedChatData), {
    access: 'private' as any,
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}
