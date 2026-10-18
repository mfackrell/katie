import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import { listChats } from '@/lib/data/persistence-store';

export async function GET() {
  try {
    // Restrict the global approval index to chats visible in Katie's own chat list.
    // Only lightweight identifying information is returned: approval digests and
    // full specifications are fetched from the owning chat when the user opens it.
    const chats = await listChats();
    const visible = new Map(chats.map(chat => [chat.id, chat]));
    if (visible.size === 0) {
      return NextResponse.json({ approvals: [] }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const { data, error } = await getSupabaseAdminClient().from('work_projects')
      .select('actor_id,chat_id,status,spec,updated_at')
      .eq('status', 'awaiting_approval').order('updated_at', { ascending: false }).limit(50);
    if (error) throw Error('Project approval records unavailable');
    const approvals = ((data ?? []) as Array<{ actor_id: string; chat_id: string; spec: unknown }>).flatMap(project => {
      const chat = visible.get(project.chat_id);
      if (!chat || chat.actorId !== project.actor_id) return [];
      const spec = project.spec as { name?: unknown } | null;
      return [{
        actorId: project.actor_id,
        chatId: project.chat_id,
        chatTitle: chat.title,
        projectName: typeof spec?.name === 'string' ? spec.name : 'Project',
      }];
    });
    return NextResponse.json({ approvals }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Projects] Pending approval discovery unavailable', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Unable to load pending project approvals' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
