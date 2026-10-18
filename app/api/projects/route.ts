import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getChatById, getMessages } from '@/lib/data/persistence-store';
import { projectForChat, projectRpc, type Project } from '@/lib/projects/store';

const projectIdentity = z.object({ actorId: z.string().uuid(), chatId: z.string().uuid() });
const approvalInput = projectIdentity.extend({ approvalHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

async function ownedProject(actorId: string, chatId: string) {
    const c = await getChatById(chatId);
    if (c?.actorId !== actorId) return null;
    return projectForChat(actorId, chatId);
}

function approvalFor(p: Project | null) {
    if (!p || p.status !== 'awaiting_approval' || !p.spec || !p.approval_hash || !p.repository_id) return null;
    return {
        hash: p.approval_hash,
        name: p.spec.name,
        summary: p.spec.summary,
        requirements: p.spec.requirements,
        milestones: p.spec.milestones.map(m => m.title),
        allowedPaths: p.spec.allowedPaths,
        repository: p.repository_full_name,
        deadline: p.deadline,
        limits: { codingJobs: p.max_cycles, modelTokens: p.token_allowance, missions: p.max_missions },
        specification: p.spec,
    };
}

export async function GET(request: NextRequest) {
    try {
        const { actorId, chatId } = projectIdentity.parse({
            actorId: request.nextUrl.searchParams.get('actorId'),
            chatId: request.nextUrl.searchParams.get('chatId'),
        });
        const c = await getChatById(chatId);
        if (c?.actorId !== actorId) return NextResponse.json({ error: 'Project chat unavailable' }, { status: 404 });
        const p = await projectForChat(actorId, chatId);
        return NextResponse.json({
            active: p?.status === 'running',
            status: p?.status ?? null,
            approval: approvalFor(p),
            messages: await getMessages(chatId),
        }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
        if (error instanceof z.ZodError) return NextResponse.json({ error: 'Invalid project identity' }, { status: 400 });
        return NextResponse.json({ error: 'Project progress unavailable' }, { status: 503 });
    }
}

// The click is a direct, scope-bound user approval; it uses the same audited,
// server-owned DB transition as the existing typed "approve project <hash>".
// An old or mismatched approval digest cannot start coding.
export async function POST(request: NextRequest) {
    let input: z.infer<typeof approvalInput>;
    try { input = approvalInput.parse(await request.json()); }
    catch { return NextResponse.json({ error: 'Invalid project approval request' }, { status: 400 }); }
    try {
        const p = await ownedProject(input.actorId, input.chatId);
        if (!p) return NextResponse.json({ error: 'Project chat unavailable' }, { status: 404 });
        if (p.status !== 'awaiting_approval' || !p.spec || !p.repository_id || p.approval_hash !== input.approvalHash)
            return NextResponse.json({ error: 'This approval is no longer current. Refresh the project scope.' }, { status: 409 });
        const updated = await projectRpc<Project>('control_work_project', {
            p_id: p.id, p_actor: input.actorId, p_chat: input.chatId,
            p_action: 'approve', p_hash: input.approvalHash,
        });
        return NextResponse.json({ status: updated.status, messages: await getMessages(input.chatId) }, {
            headers: { 'Cache-Control': 'no-store' },
        });
    } catch {
        return NextResponse.json({ error: 'Approval could not be saved. Refresh the scope and try again.' }, { status: 409 });
    }
}
