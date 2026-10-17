import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import type { Message } from '@/lib/types/chat';
import { projectForChat, projectRpc, type Project } from './store';
import { projectId, projectMessage } from './contract';
export function startProjectIntent(text: string) {
 const direct=/^\s*(?:please\s+)?(?:(?:can|could|would|will) you\s+(?:please\s+)?)?(?:build|create|develop|recreate|re-create|make|implement|launch|start)\b/i.test(text);
 const desire=/^\s*I (?:want|need|would like)\b/i.test(text) && !/^.{0,100}\b(?:explain|understand|learn|discuss|describe|whether|capable|how to)\b/i.test(text.split(/[.!?]\s/)[0]);
 return (direct||desire) && /\b(?:project|browser|website|web app|application|app|game|dashboard|portal)\b/i.test(text) && !/^.{0,80}\b(?:do not|don't|never|not asking you to)\s+(?:want to |you to )?(?:build|create|develop|make|implement|start)\b/i.test(text);
}
export const followupProjectIntent = (text: string) => /^(?:please\s+)?(?:build|make|create|implement|do|start)(?:\s+(?:that|it|this|the project))?[.!\s]*$/i.test(text.trim());
const marker = /<!-- katie-project-status:[a-f0-9-]+:([^ ]+) -->/;
export async function handleProjectChat(input: {
    actorId: string;
    chatId: string;
    message: string;
    activeRepoId?: string;
}, requestId: string, history: Message[], tracked: boolean): Promise<string | null> {
    const text = input.message.trim(), pending = history.some(m => m.role === 'assistant' && marker.test(m.content) && !['completed', 'stopped'].includes(m.content.match(marker)![1]));
    const start = startProjectIntent(text), follow = followupProjectIntent(text), control = /\b(?:project|progress|status|pause|stop|resume|continue|approve|game|edition|requirement|keyboard|multiplayer)\b|^go ahead|how.{0,12}going/i.test(text);
    if (!pending && !start && !follow && !control)
        return null;
    const p = await projectForChat(input.actorId, input.chatId);
    const reply = (p: Project, body: string) => projectMessage(p.id, p.status, body);
    const mutate = async (action: string, opts: Record<string, unknown> = {}) => projectRpc<Project>('control_work_project', { p_id: p!.id, p_actor: input.actorId, p_chat: input.chatId, p_action: action, ...opts });
    if (p && !['completed', 'stopped'].includes(p.status)) {
        if (/^(?:please\s+)?(?:pause|stop|cancel)(?:\s+(?:this|the|my))?(?:\s+(?:project|work))?[.!\s]*$/i.test(text)) {
            const paused = /pause/i.test(text);
            const n = await mutate(paused ? 'pause' : 'stop');
            return reply(n, n.detail!);
        }
        if (/^(?:please\s+)?(?:resume|continue)(?:\s+(?:this|the|my))?(?:\s+project)?[.!\s]*$/i.test(text)) {
            const n = await mutate('resume');
            return reply(n, n.detail!);
        }
        if (/\b(?:status|progress)\b|how.{0,12}going|is (?:the project|it) (?:done|finished)/i.test(text))
            return reply(p, p.status === 'awaiting_approval' ? await projectRpc<string>('project_scope_proposal', {p_id:p.id}) : p.result ?? `${p.detail ?? p.status}\nCurrent phase: ${p.phase}. Coding jobs used: ${p.cycles}/${p.max_cycles}. I have not marked this project complete.`);
        const latestAssistant = [...history].reverse().find(m => m.role === 'assistant');
        const explicit = /^approve(?: this| the)? project\s+([a-f0-9]{12,64})[.!\s]*$/i.exec(text);
        const contextual = /^(?:yes[,\s]*)?(?:approve(?: (?:this |the )?project)?|go ahead|do it|proceed)[.!\s]*$/i.test(text) && latestAssistant?.content.includes(p.approval_hash ?? 'NO_APPROVAL') && p.status === 'awaiting_approval';
        if (explicit || contextual) {
            if (p.status !== 'awaiting_approval' || !p.approval_hash || explicit?.[1] && !p.approval_hash.startsWith(explicit[1]))
                return reply(p, 'That approval does not match a pending saved scope. Ask for project status to inspect the current proposal.');
            if (!tracked)
                throw Error('Durable chat request tracking is required for project approval');
            const n = await mutate('approve', { p_hash: p.approval_hash });
            return reply(n, 'Approved. I will manage the saved milestones and permitted repairs, verify the integrated result, and return it here. You can close this page.');
        }
        if (/^(?:yes[,\s]*)?(?:approve|go ahead|do it|proceed)\b/i.test(text)) return reply(p,'Please include the current approval digest shown with the exact project proposal, or reply directly after that still-current proposal. No scope was approved.');
        if (['running','paused','blocked'].includes(p.status) && !/^\s*(?:what|why|how|can|would|could|is|are)\b/i.test(text) && /\b(?:the|this|my) (?:game|app|website|project)\b|\b(?:edition|requirement|keyboard|multiplayer)\b|^(?:please )?(?:change|amend|revise|update) (?:the |this )?project/i.test(text)) {
            if(!tracked)throw Error('Durable tracking is required for a project clarification');
            const n=await mutate('amend',{p_text:text});return reply(n,n.detail!);
        }
        if (['awaiting_input', 'awaiting_approval'].includes(p.status) && !/^\s*(?:what|why|how|can|would|could|is|are)\b/i.test(text)) {
            const repo = await repository(input.activeRepoId, text);
            if (!tracked)
                throw Error('Durable chat request tracking is required for project decisions');
            const n = await mutate('answer', { p_text: text, p_repository: repo });
            return reply(n, 'I saved that clarification and will update the project scope before coding.');
        }
        if (start || follow)
            return reply(p, 'I am already managing a project in this chat. Ask for its status, pause or stop it, or start a separate chat for a different project.');
        return null;
    }
    if (!start && !follow) {
        if (p && /status|progress|done|finished/i.test(text))
            return reply(p, p.result ?? p.detail ?? p.status);
        return null;
    }
    if (!tracked)
        throw Error('Durable chat request tracking is required before launching background projects');
    let objective = text;
    if (follow) {
        const prior = [...history].reverse().find(m => m.role === 'user' && m.content.trim().length > 40 && /\b(?:browser|website|web app|app|application|game|project|portal)\b/i.test(m.content));
        if (!prior)
            return 'What outcome should I build? Describe the app or project you want delivered; I do not have an unambiguous saved user request to act on.';
        objective = prior.content;
    }
    if (objective.length > 8000)
        return 'Please narrow the project brief to 8,000 characters. I will not silently truncate its requirements.';
    const created = await projectRpc<Project>('create_work_project', { p_id: projectId(requestId), p_request: requestId, p_actor: input.actorId, p_chat: input.chatId, p_objective: objective, p_repository: await repository(input.activeRepoId, text) });
    return reply(created, 'I’ve started a persistent project for this outcome. I’ll research it, preserve the requirements, prepare the architecture and exact acceptance checks, then ask once for the scoped coding approval. After that I’ll manage successive implementation, testing, permitted repairs and preview delivery and bring the result back to this chat. You can close this page.');
}
async function repository(active: string | undefined, text: string) { const db = getSupabaseAdminClient(); if (active) {
    const { data, error } = await db.from('repo_sync_runs').select('id').eq('id', active).maybeSingle<{
        id: string;
    }>();
    if (error || !data)
        throw Error('Selected connected repository unavailable');
    return data.id;
} const { data, error } = await db.from('repo_sync_runs').select('id,repository_full_name').order('created_at', { ascending: false }).limit(100); if (error)
    throw Error('Connected repository list unavailable'); const matches = ((data ?? []) as Array<{
    id: string;
    repository_full_name: string;
}>).filter(r => typeof r.repository_full_name === 'string' && text.toLowerCase().includes(r.repository_full_name.toLowerCase())); return matches[0]?.id ?? null; }
