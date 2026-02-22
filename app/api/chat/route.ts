import { streamText } from 'ai';
import { z } from 'zod';
import { getActor, getRecentMessages, saveMessage } from '@/lib/db';
import { getConversationSummary } from '@/lib/kv';
import { buildMemoryContext } from '@/lib/memory';
import { resolveModel } from '@/lib/providers';
import { pickModel } from '@/lib/router/master-router';

const requestSchema = z.object({
  actorId: z.string().min(1),
  chatId: z.string().min(1),
  message: z.string().min(1)
});

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json());

  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { actorId, chatId, message } = parsed.data;

  const [actor, summary, recentMessages] = await Promise.all([
    getActor(actorId),
    getConversationSummary(chatId),
    getRecentMessages(chatId, 20)
  ]);

  const { selection, reason } = await pickModel(message);
  const model = resolveModel(selection.provider, selection.modelId);

  const system = buildMemoryContext({
    systemPrompt: actor.systemPrompt,
    summary,
    recentMessages
  });

  await saveMessage(chatId, 'user', message);

  const result = streamText({
    model,
    system,
    prompt: `${message}\n\n[ROUTER_REASON: ${reason}]`
  });

  result.text.then(async (output) => {
    await saveMessage(chatId, 'assistant', output);
  });

  return result.toDataStreamResponse();
}
