import { kv } from '@vercel/kv';

export async function getConversationSummary(chatId: string): Promise<string> {
  return (await kv.get<string>(`chat:${chatId}:summary`)) ?? '';
}

export async function setConversationSummary(chatId: string, summary: string) {
  await kv.set(`chat:${chatId}:summary`, summary);
}
