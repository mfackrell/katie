import { sql } from '@vercel/postgres';
import type { Actor, ChatMessage } from '@/lib/types';

export async function getActor(actorId: string): Promise<Actor> {
  const result = await sql<Actor>`
    SELECT id, name, avatar_url AS "avatarUrl", system_prompt AS "systemPrompt"
    FROM actors
    WHERE id = ${actorId}
    LIMIT 1
  `;

  if (result.rows.length === 0) {
    throw new Error(`Actor ${actorId} not found`);
  }

  return result.rows[0];
}

export async function getRecentMessages(chatId: string, limit = 20): Promise<ChatMessage[]> {
  const result = await sql<ChatMessage>`
    SELECT role, content, created_at AS "createdAt"
    FROM messages
    WHERE chat_id = ${chatId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  return result.rows.reverse();
}

export async function saveMessage(chatId: string, role: ChatMessage['role'], content: string) {
  await sql`
    INSERT INTO messages (chat_id, role, content)
    VALUES (${chatId}, ${role}, ${content})
  `;
}
