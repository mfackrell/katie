import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import { rpc, readMission } from '@/lib/missions/store';
import type { ProjectPlan } from './contract';
export type BrowserContract = ProjectPlan['finalContract'];
export type Context = {
    game?: ProjectPlan['game'];
    gameFinal?: boolean;
    version: 1;
    projectId: string;
    baseSha: string;
    baselineSha: string;
    allowedPaths: string[];
    contractHash: string;
    contract: BrowserContract;
    scopeHash: string;
};
export type Project = {
    profile?: 'software'|'game';
    id: string;
    actor_id: string;
    chat_id: string;
    objective: string;
    clarifications: string;
    repository_id: string | null;
    repository_full_name: string | null;
    status: string;
    phase: string;
    spec: ProjectPlan | null;
    approval_hash: string | null;
    approved_hash: string | null;
    baseline_sha: string | null;
    verified_sha: string | null;
    preview: {
        url: string;
        headSha: string;
        deploymentId:number;
        statusId:number;
        browserAcceptance?:{passed:boolean;headSha:string;deploymentId:number;contractHash:string;url:string};
    } | null;
    milestone_index: number;
    cycles: number;
    max_cycles: number;
    max_missions: number;
    token_allowance: number; // Enforced authorization, not the resource forecast
    estimated_tokens?: number | null;
    estimate_rationale?: string | null;
    estimate_updated_at?: string | null;
    budget_authorization_source?: 'legacy_default'|'user_approved'|'policy';
    deadline: string;
    active_mission_id: string | null;
    lease: string;
    detail: string | null;
    result: string | null;
};
export type Run = {
    created_at: string;
    mission_id: string;
    kind: string;
    ordinal: number;
    milestone_index: number;
    binding: Context | null;
    outcome: Record<string, unknown> | null;
};
export const projectRpc = rpc;
export async function projectForChat(actor: string, chat: string) { const { data, error } = await getSupabaseAdminClient().from('work_projects').select('*').eq('actor_id', actor).eq('chat_id', chat).order('created_at', { ascending: false }).limit(1); if (error)
    throw Error('Project history unavailable'); return (data?.[0] ?? null) as Project | null; }
export async function projectRuns(id: string) { const { data, error } = await getSupabaseAdminClient().from('project_runs').select('*').eq('project_id', id).order('ordinal', { ascending: true }); if (error)
    throw Error('Project milestones unavailable'); return (data ?? []) as Run[]; }
export async function getDevelopmentProjectContext(jobId: string, forDispatch = false): Promise<Context | null> { const db = getSupabaseAdminClient(); const { data: j, error: e } = await db.from('mission_assignments').select('mission_id').eq('id', jobId).maybeSingle<{
    mission_id: string;
}>(); if (e)
    throw Error('Project assignment binding unavailable'); if (!j)
    return null; const { data: r, error: re } = await db.from('project_runs').select('*').eq('mission_id', j.mission_id).maybeSingle<Run>(); if (re)
    throw Error('Project cycle binding unavailable'); if (!r?.binding)
    return null; const { data: p, error: pe } = await db.from('work_projects').select('*').eq('id', r.binding.projectId).maybeSingle<Project>(); if (pe || !p || forDispatch && (!p.approved_hash || p.approved_hash !== p.approval_hash || p.approved_hash !== r.binding.scopeHash || p.status !== 'running' || p.active_mission_id !== r.mission_id))
    throw Error('Approved project scope is unavailable or changed');
    if(forDispatch&&p.profile==='game'&&!await projectRpc<boolean>('game_project_specialist_valid',{p_id:p.id}))throw Error('Pinned game specialist changed before dispatch');
    return {...r.binding,...(p?.profile==='game'&&p.spec?.game?{game:p.spec.game,gameFinal:r.milestone_index===p.spec.milestones.length-1}:{})}; }
export const acceptanceBinding = (c: Context) => ({ projectId: c.projectId, contractHash: c.contractHash, scenarioNames: c.contract.scenarios.map(s => s.name) });
export async function milestoneEvidence(runs: Run[]) { const result = []; for (const r of runs.filter(r => r.outcome)) {
    const { mission } = await readMission(r.mission_id);
    result.push({ phase: r.kind, index: r.milestone_index, result: mission.result, missionStatus:mission.status,evidence: r.outcome });
} return result; }
