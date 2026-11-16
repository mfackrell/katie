import { z } from 'zod';
import type { createDocumentStore } from './storage';

const query = z.object({ actorId: z.string().uuid(), chatId: z.string().uuid(), id: z.string().regex(/^[a-f0-9]{64}$/), format: z.enum(['docx', 'pdf']) });
export function createDocumentDownload(deps: {
  authenticate(request: Request): Promise<{ id: string; isAnonymous: boolean }>;
  authorize(request: Request, actorId: string, chatId: string): Promise<unknown>;
  chat(chatId: string): Promise<{ actorId: string } | null>;
  store(): ReturnType<typeof createDocumentStore>;
  ownerId?: string;
}) {
  return async (request: Request): Promise<Response> => {
    try {
      const value = query.parse(Object.fromEntries(new URL(request.url).searchParams));
      const principal = await deps.authenticate(request);
      const chat = await deps.chat(value.chatId);
      if (!chat || chat.actorId !== value.actorId) throw new Error('scope');
      if (principal.isAnonymous || principal.id !== deps.ownerId) await deps.authorize(request, value.actorId, value.chatId);
      const { bytes, file } = await deps.store().read({ ownerId: principal.id, actorId: value.actorId, chatId: value.chatId }, value.id, value.format);
      return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': file.mime,
        'Content-Disposition': `attachment; filename="${file.filename}"`, 'Content-Length': String(bytes.length),
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      } });
    } catch {
      return Response.json({ error: 'Document unavailable or access denied.' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
    }
  };
}
