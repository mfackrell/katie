import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getChatById, getMessages } from '@/lib/data/persistence-store';
import { projectForChat } from '@/lib/projects/store';
export async function GET(request: NextRequest) { try {
    const actor = z.string().uuid().parse(request.nextUrl.searchParams.get('actorId')), chat = z.string().uuid().parse(request.nextUrl.searchParams.get('chatId'));
    const c = await getChatById(chat);
    if (c?.actorId !== actor)
        return NextResponse.json({ error: 'Project chat unavailable' }, { status: 404 });
    const p = await projectForChat(actor, chat);
    return NextResponse.json({ active: p?.status === 'running', status: p?.status ?? null, messages: await getMessages(chat) }, { headers: { 'Cache-Control': 'no-store' } });
}
catch {
    return NextResponse.json({ error: 'Project progress unavailable' }, { status: 503 });
} }
