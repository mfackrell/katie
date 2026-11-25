import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import {managementActivationOffer,ORIGINAL_TTT_PROJECT,APPROVED_TTT_CUTOFF} from '@/lib/projects/management-activation';
import {blockedOwnerRecoveryOffer} from '@/lib/projects/blocked-owner-recovery';
import {blockedManagementRetestOffer} from '@/lib/projects/blocked-management-retest';
import {mission79FutureWindowOffer} from '@/lib/projects/mission79-future-window';
import {mission79RetryOffer} from '@/lib/projects/mission79-retry';
import {mission80WatchdogOffer} from '@/lib/projects/mission80-watchdog';
import {mission82WatchdogOffer} from '@/lib/projects/mission82-watchdog';
import {originalBoundedRecoveryOffer} from '@/lib/projects/original-bounded-recovery';
import {mission84ProviderRetryOffer} from '@/lib/projects/mission84-provider-retry';
import {managementContextRetestOffer} from '@/lib/projects/management-context-retest';
import {followupManagementRetestOffer} from '@/lib/projects/management-followup-retest';
import {codingCapacityOffer} from '@/lib/projects/coding-capacity-recovery';
import {packageExecutionOffer} from '@/lib/projects/package-execution-authorization';
import type { DirectorRecoveryOffer } from '@/components/director-recovery-control';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { recoveryResourceProposal } from '@/lib/projects/recovery-budget';
import { verifiedProjectOwnerSession } from '@/lib/projects/owner-authorization';
import { getChatById, getMessages } from '@/lib/data/persistence-store';
import { projectForChat, projectRpc, type Project } from '@/lib/projects/store';
import { hasPendingExecutiveDelivery } from '@/lib/executive/delivery';

const projectIdentity = z.object({ actorId: z.string().uuid(), chatId: z.string().uuid() });
const approvalInput = projectIdentity.extend({ approvalHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const scopeRatificationInput = projectIdentity.extend({
    proposalId: z.string().uuid(),
    approvalHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

async function ownedProject(actorId: string, chatId: string) {
    const c = await getChatById(chatId);
    if (c?.actorId !== actorId) return null;
    return projectForChat(actorId, chatId);
}

function approvalFor(p: Project | null,providerControlled: boolean) {
    if (!p || p.status !== 'awaiting_approval' || !p.spec || !p.approval_hash || !p.repository_id) return null;
    return {
        hash: p.approval_hash,
        providerControlled,
        name: p.spec.name,
        summary: p.spec.summary,
        requirements: p.spec.requirements,
        milestones: p.spec.milestones.map(m => m.title),
        allowedPaths: p.spec.allowedPaths,
        repository: p.repository_full_name,
        deadline: p.deadline,
        resourceBudget: {
            estimatedTokens: p.estimated_tokens ?? null,
            authorizedTokens: p.token_allowance,
            authorizationSource: p.budget_authorization_source ?? 'legacy_default',
            estimateRationale: p.estimate_rationale ?? null,
        },
        limits: { codingJobs: p.max_cycles, modelTokens: p.token_allowance, missions: p.max_missions },
        specification: p.spec,
    };
}

async function directorRecoveryFor(p: Project | null, request: NextRequest, providerControlled: boolean): Promise<DirectorRecoveryOffer | null> {
    if (!p || !providerControlled
        || !await verifiedProjectOwnerSession(request)) return null;
    const releaseSha = process.env.VERCEL_GIT_COMMIT_SHA;
    if (!/^[a-f0-9]{40}$/.test(releaseSha ?? '')) return null;
    if(p.id===ORIGINAL_TTT_PROJECT&&p.phase==='development'&&process.env.VERCEL_ENV==='production'){
        if(p.status==='paused'&&p.max_missions===104){
            try{
                const offer=await packageExecutionOffer(p.id);
                return {projectId:p.id,releaseSha:releaseSha!,cutoff:offer.cutoff,priorCutoff:offer.cutoff,receipt:null,packageExecutionRecovery:offer};
            }catch{return null;}
        }
        try{
            const coding=await codingCapacityOffer(p.id);
            return {projectId:p.id,releaseSha:releaseSha!,cutoff:coding.cutoff,priorCutoff:coding.cutoff,receipt:null,codingCapacityRecovery:coding};
        }catch{ /* Not the exact exhausted original commissioning state. */ }
        // Signed followup after a prior accepted owner recovery, never a
        // continuation inferred from its spent historical receipt.
        try{
            const latest=await followupManagementRetestOffer(p.id);
            return {projectId:p.id,releaseSha:releaseSha!,cutoff:latest.cutoff,
                priorCutoff:latest.cutoff,receipt:null,followupManagementRetest:latest};
        }catch{ /* Exact current late-stage owner recovery not eligible. */ }
        // A current pre-inference management overflow must pass the exact
        // live decision assembler before any new one-attempt owner approval.
        try{
            const retest=await managementContextRetestOffer(p.id);
            return {projectId:p.id,releaseSha:releaseSha!,cutoff:retest.cutoff,
                priorCutoff:retest.cutoff,receipt:null,managementContextRetest:retest};
        }catch{ /* Unavailable or changed preflight must fail closed. */ }
        // A reconciled stopped Mission84 needs its own fresh signed owner retry.
        try{
            const m84=await mission84ProviderRetryOffer(p.id);
            return {projectId:p.id,releaseSha:releaseSha!,cutoff:m84.cutoff,
                priorCutoff:m84.cutoff,receipt:null,mission84ProviderRetry:m84};
        }catch{ /* No reconciled single-retry offer; historical controls remain read only. */ }
        // The current 84-mission blocked/expired original project must offer
        // owner-selected NEW authority before any spent legacy recovery control.
        try{
            const bounded=await originalBoundedRecoveryOffer(p.id);
            return {projectId:p.id,releaseSha:releaseSha!,cutoff:bounded.priorCutoff,
                priorCutoff:bounded.priorCutoff,receipt:null,originalBoundedRecovery:bounded};
        }catch{ /* Exact 84-mission owner approval state is unavailable. */ }
        // A legitimate Project Director escalation after rejected Mission81 has
        // a distinct, single-use owner recovery; no spent retry is inherited.
        try{
            const m82=await mission82WatchdogOffer(p.id);
            return {projectId:p.id,releaseSha:releaseSha!,cutoff:m82.cutoff,
                priorCutoff:m82.cutoff,receipt:null,mission82Recovery:m82};
        }catch{ /* The exact blocked Mission82 escalation is not recoverable here. */ }
        // The original blocked Mission80 now has its own authenticated, new-release
        // owner recovery. Do not fall back to spent Mission79 authority.
        try{
            const m80=await mission80WatchdogOffer(p.id);
            return {projectId:p.id,releaseSha:releaseSha!,cutoff:m80.cutoff,
                priorCutoff:m80.cutoff,receipt:null,mission80Recovery:m80};
        }catch{ /* Not the exact original Mission80 recovery state. */ }
        // A previously spent Mission79 has a separate one-time owner approval
        // offer, rather than the original unclaimed-window control.
        try{
            const retry=await mission79RetryOffer(p.id);
            return {projectId:p.id,releaseSha:releaseSha!,cutoff:retry.cutoff,
                priorCutoff:retry.cutoff,receipt:null,mission79Retry:retry};
        }catch{ /* Not an exact failed Mission79 offer; retain older pathways. */ }
        try{
            const renewal=await mission79FutureWindowOffer(p.id);
            return {projectId:p.id,releaseSha:releaseSha!,cutoff:renewal.cutoff??renewal.priorCutoff,
                priorCutoff:renewal.priorCutoff,receipt:null,mission79FutureWindow:renewal};
        }catch{
            // Never replace a valid original mission79 recovery with a legacy
            // approval control just because Vercel moved the canonical alias.
            // This read-only check cannot change release authority or spend.
            try{
                const epoch=await projectRpc<{active:boolean;generation:number;deploymentId:string|null}>(
                    'project_org_retest_release_epoch',{p_project:p.id,p_release:releaseSha});
                if(epoch&&Number.isSafeInteger(epoch.generation)&&epoch.generation>0&&epoch.active===false)
                    return {projectId:p.id,releaseSha:releaseSha!,cutoff:p.deadline,priorCutoff:p.deadline,
                        receipt:null,managementActivationError:
                        'Original mission 79 is locked: the current production deployment does not match its recorded security release. A release operator must verify and restore the exact release gate before you can approve a new window. No owner approval was recorded.'};
            }catch{ /* Retain the existing legacy recovery fallback if epoch lookup is unavailable. */ }
        }
        try{
            const retest=await blockedManagementRetestOffer(p.id);
            return {projectId:p.id,releaseSha:releaseSha!,cutoff:retest.cutoff,priorCutoff:retest.cutoff,
                receipt:null,managementRetest:retest};
        }catch{ /* Retest is not applicable to the current saved state; check original recovery. */ }
        try{
            const activation=await managementActivationOffer(p.id);
            return {projectId:p.id,releaseSha:releaseSha!,cutoff:activation.cutoff,priorCutoff:activation.priorCutoff,
                receipt:null,managementActivation:activation};
        }catch{
            try{
                const blocked=await blockedOwnerRecoveryOffer(p.id);
                return {projectId:p.id,releaseSha:releaseSha!,cutoff:blocked.cutoff??blocked.priorCutoff,
                    priorCutoff:blocked.priorCutoff,receipt:null,blockedOwnerRecovery:blocked};
            }catch{
                return {projectId:p.id,releaseSha:releaseSha!,cutoff:APPROVED_TTT_CUTOFF,priorCutoff:p.deadline,receipt:null,
                    managementActivationError:'Recovery state is unavailable or changed. Refresh project status before continuing.'};
            }
        }
    }
    const cutoff = '2026-11-12T00:00:00Z';
    const priorCutoff = '2026-11-10T18:59:32.547837Z';
    const { data, error } = await getSupabaseAdminClient().from('project_director_recoveries')
        .select('mission_id,assignment_id,cutoff').eq('project_id', p.id).eq('owner_id',process.env.KATIE_OWNER_AUTH_USER_ID).maybeSingle<{
            mission_id: string; assignment_id: string; cutoff: string;
        }>();
    if (error) throw Error('Director recovery admission state unavailable');
    let continuation: DirectorRecoveryOffer['continuation'];
    const window=await projectRpc<{decisionId:string;admittedAt:string|null;cutoff:string;maxCutoff:string;authorizationId?:string;authorizedAt?:string}|null>('project_org_owner_window_offer',{
            p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.id,
    });
    const windowReceipt=window&&typeof window==='object'&&typeof window.authorizationId==='string'&&typeof window.authorizedAt==='string'?{authorizationId:window.authorizationId,authorizedAt:window.authorizedAt}:{};
    // Read-only preflight: the owner will approve a new cutoff in a separate
    // authenticated action. Never implicitly restore expired appointments.
    const hierarchyOffer=process.env.VERCEL_ENV==='production'&&p.status==='blocked'&&Date.now()>=Date.parse(p.deadline)
        ?await projectRpc<{decisionId:string;directorCutoff:string;priorCutoff:string;stateHash:string;nodeCount:number;maxHours:number;activeMissionId:string|null}|null>(
            'project_org_hierarchy_recovery_offer',{p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.id})
        :null;
    const hierarchyRecovery=hierarchyOffer&&typeof hierarchyOffer==='object'&&
        /^[a-f0-9]{64}$/.test(hierarchyOffer.stateHash??'')&&
        typeof hierarchyOffer.decisionId==='string'&&Number.isFinite(Date.parse(hierarchyOffer.directorCutoff))&&
        Number.isFinite(Date.parse(hierarchyOffer.priorCutoff))&&hierarchyOffer.nodeCount>0
        ?{decisionId:hierarchyOffer.decisionId,directorCutoff:hierarchyOffer.directorCutoff,
            priorCutoff:hierarchyOffer.priorCutoff,stateHash:hierarchyOffer.stateHash,
            nodeCount:hierarchyOffer.nodeCount,maxHours:hierarchyOffer.maxHours,activeMissionId:hierarchyOffer.activeMissionId}
        :null;
    if(!data){
        if(window&&typeof window==='object'&&typeof window.decisionId==='string'
            &&(Date.now()>=Date.parse(window.cutoff)||window.admittedAt))
            continuation={decisionId:window.decisionId,admittedAt:window.admittedAt,maxCutoff:window.maxCutoff,...windowReceipt};
    }
    if(!data&&!continuation&&(p.id!=='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'||p.status!=='blocked'||p.phase!=='research'
        ||Date.now()>=Date.parse(cutoff)||Date.parse(p.deadline)!==Date.parse(priorCutoff)))return null;
    if(data){
        const db=getSupabaseAdminClient();
        const [decision,authority]=await Promise.all([
            db.from('project_organization_decisions').select('id').eq('project_id',p.id).eq('assignment_id',data.assignment_id).maybeSingle<{id:string}>(),
            db.from('project_provider_execution').select('continued_at').eq('project_id',p.id).single<{continued_at:string|null}>(),
        ]);
        if(decision.error||authority.error)throw Error('Project continuation state unavailable');
        if(decision.data)continuation={decisionId:decision.data.id,admittedAt:authority.data?.continued_at??null,...(window&&typeof window==='object'&&window.maxCutoff?{maxCutoff:window.maxCutoff}:{}),...windowReceipt};
    }
    return {
        projectId: p.id, releaseSha: releaseSha!, cutoff:continuation?p.deadline:cutoff, priorCutoff,
        receipt: data ? {projectId: p.id, missionId: data.mission_id, assignmentId: data.assignment_id, cutoff: data.cutoff, existing: true} : null,
        ...(continuation?{continuation}:{}),
        ...(hierarchyRecovery?{hierarchyRecovery}:{}),
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
        const messages = await getMessages(chatId);
        const executivePending = await hasPendingExecutiveDelivery(actorId, chatId, messages);
        const providerControlled=!!(p?.organization_version===1&&await projectRpc<boolean>('project_provider_mode',{p_project:p.id}));
        const resourceRecovery = p&&!providerControlled ? await recoveryResourceProposal(p) : null;
        return NextResponse.json({
            resourceRecovery,
            directorRecovery: await directorRecoveryFor(p, request, providerControlled),
            active: p?.status === 'running',
            status: p?.status ?? null,
            approval: approvalFor(p,providerControlled),
            trialState: providerControlled ? 'active' : !p&&!messages.length&&await verifiedProjectOwnerSession(request) ? 'available' : null,
            resourceBudget: p&&!providerControlled ? {
                estimatedTokens: p.estimated_tokens ?? null,
                authorizedTokens: p.token_allowance,
                authorizationSource: p.budget_authorization_source ?? 'legacy_default',
                estimateRationale: p.estimate_rationale ?? null,
                safeguards: { maxMissions: p.max_missions, maxCodingCycles: p.max_cycles, deadline: p.deadline },
            } : null,
            messages,
            executivePending,
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
        const providerControlled=p.organization_version===1&&await projectRpc<boolean>('project_provider_mode',{p_project:p.id});
        if(providerControlled&&!await verifiedProjectOwnerSession(request))
            return NextResponse.json({error:'Sign in as Katie owner to approve this trial scope.'},{status:403});
        const updated = providerControlled
          ? await projectRpc<Project>('project_provider_approve_scope',{p_project:p.id,p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_hash:p.approval_hash})
          : await projectRpc<Project>('control_work_project', {
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

// Scope ratification is deliberately separate from ordinary project approval.
// The client supplies only the immutable proposal identity and exact digest;
// specification content and file paths cannot be substituted at approval time.
export async function PUT(request: NextRequest) {
    let input: z.infer<typeof scopeRatificationInput>;
    try { input = scopeRatificationInput.parse(await request.json()); }
    catch { return NextResponse.json({ error: 'Invalid scope ratification approval' }, { status: 400 }); }
    if (!await verifiedProjectOwnerSession(request))
        return NextResponse.json({ error: 'Authenticated Katie owner session required for scope ratification' }, { status: 403 });
    try {
        const p = await ownedProject(input.actorId, input.chatId);
        if (!p) return NextResponse.json({ error: 'Project chat unavailable' }, { status: 404 });
        const ownerId = process.env.KATIE_OWNER_AUTH_USER_ID;
        if (!ownerId || !/^[a-f0-9-]{36}$/i.test(ownerId))
            return NextResponse.json({ error: 'Owner scope identity unavailable' }, { status: 503 });
        const updated = await projectRpc<Project>('project_org_ratify_scope', {
            p_owner: ownerId, p_project: p.id, p_proposal: input.proposalId, p_hash: input.approvalHash,
        });
        return NextResponse.json({ status: updated.status, approvedScopeHash: updated.approved_hash, messages: await getMessages(input.chatId) }, {
            headers: { 'Cache-Control': 'no-store' },
        });
    } catch {
        return NextResponse.json({ error: 'Scope ratification is stale, unauthorized, or could not be committed atomically.' }, { status: 409 });
    }
}

const recoveryApprovalInput=projectIdentity.extend({
  scopeHash:z.string().regex(/^[a-f0-9]{64}$/),
  authorizedCeiling:z.number().int().positive(),
  renewalHours:z.union([z.literal(48),z.literal(72)]),
}).strict();

// Resource authorization is sensitive even when actor/chat IDs are valid.
// Ordinary Katie chats do not require sign-in; owner spending consent does.
// This follows the existing owner-session verification used by self-tools.
// Owner-initiated action only: a forecast or cron can NEVER approve spending.
export async function PATCH(request:NextRequest){
 let stage='load_owned_project';
 let input:z.infer<typeof recoveryApprovalInput>;
 try{input=recoveryApprovalInput.parse(await request.json());}
 catch{return NextResponse.json({error:'Invalid resource authorization'}, {status:400});}
 if(!await verifiedProjectOwnerSession(request))return NextResponse.json({error:'Authenticated owner session required for spending authorization'},{status:403});
 try{
  const p=await ownedProject(input.actorId,input.chatId);
  if(!p)return NextResponse.json({error:'Project chat unavailable'},{status:404});
  stage='recalculate_proposal';
  const proposal=await recoveryResourceProposal(p);
  if(!proposal||proposal.state!=='estimated'||!proposal.needsAuthorization||proposal.scopeHash!==input.scopeHash||
     proposal.proposedCeiling!==input.authorizedCeiling)
    return NextResponse.json({error:'Resource proposal changed; refresh before approving'},{status:409});
  stage='authorize_resources_rpc';
  const deadline=new Date(Date.now()+input.renewalHours*3600000).toISOString();
  const {data,error}=await (await import('@/lib/data/supabase/admin')).getSupabaseAdminClient().rpc(
   'authorize_work_project_resources',{
    p_id:p.id,p_actor:input.actorId,p_chat:input.chatId,p_expected_allowance:p.token_allowance,
    p_authorized_allowance:input.authorizedCeiling>p.token_allowance?input.authorizedCeiling:null,
    p_max_missions:proposal.proposedMaxMissions>p.max_missions?proposal.proposedMaxMissions:null,
    p_deadline:deadline,p_approval_ref:randomUUID(),
    p_approval_note:'Owner explicitly approved the Developer Orchestrator saved-state resource proposal '+proposal.scopeHash+
      '; independent review and coding approval remain required.'
   });
  if(error)throw Error(error.message);
  // The normal Developer Orchestrator cron remains responsible for recovery;
  // never start unreviewed coding from this API request.
  return NextResponse.json({authorization:data,recovery:'pending_developer_orchestrator'});
 }catch(e){
  const message=e instanceof Error?e.message:String(e);
  console.error('[Projects] Resource authorization failed',{stage,errorType:e instanceof Error?e.name:typeof e,reason:message.slice(0,400)});
  const category=/timeout|abort|fetch|502|503|504|522|upstream/i.test(message)?'temporary_database_failure':'authorization_conflict';
  return NextResponse.json({error:category==='temporary_database_failure'?'Supabase connection failed while saving authorization; refresh project status before retrying.':'Resource authorization was rejected; project was not restarted.',code:category,stage},{status:category==='temporary_database_failure'?503:409});
 }
}
