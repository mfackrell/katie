'use server';

import { put } from '@vercel/blob';
import { revalidatePath } from 'next/cache';

export async function createChatAction(actorId: string, title: string) {
  if (!actorId || !title) return { error: "Missing actor or title" };

  const chatId = crypto.randomUUID();
  
  // Initialize the Chat Object with all 3 Memory Layers in mind
  const chatData = {
    id: chatId,
    actorId: actorId,
    title: title,
    // Layer 2: Starts empty, updated by the Summarizer LLM later
    intermediarySummary: "", 
    // Layer 3: Ephemeral context (raw messages)
    history: [], 
    createdAt: new Date().toISOString(),
  };

  try {
    // Save to Vercel Blob: chats/[actorId]/[chatId].json
    await put(`chats/${actorId}/${chatId}.json`, JSON.stringify(chatData), {
      access: 'public', 
      addRandomSuffix: false,
      contentType: 'application/json',
    });

    // Refresh the sidebar to show the new nested chat
    revalidatePath('/');
    return { success: true, chatId };
  } catch (error) {
    console.error("Chat Init Error:", error);
    return { error: "Failed to initialize chat" };
  }
}
