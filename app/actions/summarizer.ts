'use server';

import { put, head } from '@vercel/blob';
import { OpenAI } from 'openai';

const openai = new OpenAI();

export async function updateIntermediarySummary(actorId: string, chatId: string) {
  const blobUrl = `https://[your-id].public.blob.vercel-storage.com/chats/${actorId}/${chatId}.json`;
  
  // 1. Fetch current chat state
  const response = await fetch(blobUrl);
  const chatData = await response.json();

  // 2. Only summarize if we have enough messages (e.g., > 15)
  if (chatData.history.length < 15) return;

  const messagesToSummarize = chatData.history.slice(0, 10);
  const remainingMessages = chatData.history.slice(10);

  // 3. Generate the New Summary (Layer 2)
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Update the conversation summary. Retain key facts, decisions, and technical details. Current Summary: " + chatData.intermediarySummary },
      { role: "user", content: "New Messages to incorporate: " + JSON.stringify(messagesToSummarize) }
    ]
  });

  const newSummary = completion.choices[0].message.content;

  // 4. Overwrite the Blob with the new Summary and Truncated History
  const updatedChatData = {
    ...chatData,
    intermediarySummary: newSummary,
    history: remainingMessages, // Raw history is now leaner
  };

  await put(`chats/${actorId}/${chatId}.json`, JSON.stringify(updatedChatData), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}
