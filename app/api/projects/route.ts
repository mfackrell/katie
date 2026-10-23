import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { recoveryResourceProposal } from '@/lib/projects/recovery-budget';
import { getChatById, getMessages } from '@/lib/data/persistence-store';
import { projectForChat, projectRpc, type Project } from '@/lib/projects/store';
import { hasPendingExecutiveDelivery } from '@/lib/executive/delivery';

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
        const resourceRecovery = p ? await recoveryResourceProposal(p) : null;
        return NextResponse.json({
            resourceRecovery,
            active: p?.status === 'running',
            status: p?.status ?? null,
            approval: approvalFor(p),
            resourceBudget: p ? {
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

const recoveryApprovalInput=projectIdentity.extend({
  scopeHash:z.string().regex(/^[a-f0-9]{64}$/),
  authorizedCeiling:z.number().int().positive(),
  renewalHours:z.union([z.literal(48),z.literal(72)]),
}).strict();

// Owner-initiated action only: a forecast or cron can NEVER approve spending.
export async function PATCH(request:NextRequest){
 let stage='load_owned_project';
 let input:z.infer<typeof recoveryApprovalInput>;
 try{input=recoveryApprovalInput.parse(await request.json());}
 catch{return NextResponse.json({error:'Invalid resource authorization'}, {status:400});}
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
