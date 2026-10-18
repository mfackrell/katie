import {verifyDeployedPreview,PreviewAccessUnavailable} from '@/lib/projects/preview';
import { Octokit } from '@octokit/rest';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import { readMission } from '@/lib/missions/store';
import { readTask } from '@/lib/agents/store';
import { developmentPreview, projectAcceptanceSchema, reconcileDevelopment } from '@/lib/agents/development';
import { parseJSON } from '@/lib/missions/types';
import { validateProjectPlan } from './contract';
import { projectRpc, projectRuns, milestoneEvidence, acceptanceBinding, getDevelopmentProjectContext, type Project } from './store';
export async function baseline(p: Project) { if (!p.repository_id)
    return null; const { data: r, error } = await getSupabaseAdminClient().from('repo_sync_runs').select('repository_full_name').eq('id', p.repository_id).maybeSingle<{
    repository_full_name: string;
}>(); if (error || !r || !/^[-\w.]+\/[-\w.]+$/.test(r.repository_full_name))
    throw Error('Connected target repository unavailable'); if(!(process.env.PROJECT_PREVIEW_REPOSITORIES??'').split(',').map(s=>s.trim().toLowerCase()).includes(r.repository_full_name.toLowerCase()))throw Error('This target needs an explicitly configured credential-free Preview environment before project coding can be approved'); const [owner, repo] = r.repository_full_name.split('/'); const gh = new Octokit({ auth: process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT ?? process.env.GH_TOKEN, request: { timeout: 15000 } }); const m = await gh.repos.get({ owner, repo }); if (m.data.default_branch !== 'main')
    throw Error('The connected project target must use the existing main-branch autonomous workflow'); const user = await gh.users.getAuthenticated(); if (user.data.type !== 'User' || m.data.owner.type !== 'User' || user.data.login.toLowerCase() !== owner.toLowerCase())
    throw Error('The project target must be owned by the existing authenticated human GitHub owner'); const workflow = await gh.repos.getContent({ owner, repo, path: '.github/workflows/autonomous-development.yml', ref: 'main' }); if (Array.isArray(workflow.data) || !('content' in workflow.data))
    throw Error('Target project workflow is unavailable'); const source = Buffer.from(workflow.data.content, 'base64').toString('utf8'); if (!source.includes('project-browser-check.mjs') || !source.includes('projectAcceptance'))
    throw Error('The target repository needs the versioned project execution integration before coding can be approved'); if(p.verified_sha&&p.baseline_sha)return p.baseline_sha; const b = await gh.repos.getBranch({ owner, repo, branch: 'main' }); return b.data.commit.sha; }
function bounded(text: string) { if (text.length > 12000)
    throw Error('Project milestone context exceeds its bounded input. Narrow the specification; original requirements have not been truncated.'); return text; }

async function advance(p: Project) {
    const finish = (action: string, data: Record<string, unknown> = {}) => projectRpc<boolean>('finish_work_project', { p_id: p.id, p_lease: p.lease, p_action: action, p_data: data });
    const runs = await projectRuns(p.id);
    const source = `ORIGINAL USER OUTCOME (must remain authoritative):\n${p.objective}\n${p.clarifications}`;
    if (p.active_mission_id) {
        const current = await readMission(p.active_mission_id);
        const m = current.mission;
        if (m.status === 'awaiting_approval') {
            const r = runs.find(r => r.mission_id === m.id);
            if (!r?.binding || p.approved_hash !== p.approval_hash)
                throw Error('Coding requires the exact approved project scope');
            for (const j of current.jobs.filter(j => j.status === 'awaiting_approval'))
                await projectRpc('control_mission', { p_id: m.id, p_action: 'approve', p_job: j.id });
            await finish('wait', { detail: 'Approved milestone handed to the existing independent GitHub workflow.' });
            return;
        }
        if (m.status === 'blocked' || m.status === 'stopped') {
            const essential = current.jobs.map(j => j.result?.clarification).find(c => c && typeof c === 'object' && (c as {
                essential?: boolean;
            }).essential) as {
                question?: string;
            } | undefined;
            if (essential && !p.approved_hash) {
                await finish('input', { detail: essential.question ?? 'A concrete project decision is required before continuing.' });
                return;
            }
            const notes = current.jobs.filter(j => j.role === 'review').map(j => j.result?.summary ?? j.detail).filter(Boolean).join('\n');
            if (p.approved_hash && ['development', 'assessment'].includes(p.phase) && p.cycles < p.max_cycles && runs.filter(r=>r.kind==='development'&&r.milestone_index===Math.min(p.milestone_index,p.spec!.milestones.length-1)).length<2) {
                await finish('retry', { detail: 'Repair the original unmet requirements. ' + (notes || m.detail), failed_mission: m.id });
                return;
            }
            await finish('block', { detail: 'A project milestone is blocked: ' + (notes || m.detail || m.status) });
            return;
        }
        if (m.status !== 'completed') {
            await finish('wait');
            return;
        }
        if (p.phase === 'research') {
            await finish('advance', { result: m.result });
            return;
        }
        if (p.phase === 'specification') {
            const spec = validateProjectPlan(parseJSON(m.result ?? ''));
            const base = await baseline(p);
            await finish('spec', { spec, baseline: base, detail: 'Specification reviewed. ' + (p.repository_id ? 'Preparing your exact coding-scope approval.' : 'Name a connected target repository before coding can begin.') });
            return;
        }
        if (p.phase === 'development') {
            const r = runs.find(r => r.mission_id === m.id)!;
            const job = current.jobs.find(j => j.role === 'development');
            const v = job?.result?.verification as {
                observedHeadSha: string;
                testedHeadSha: string;
                reviewedHeadSha: string;
                changedFiles: Array<{
                    path: string;
                }>;
                projectAcceptance?: unknown;
            } | undefined;
            if (!r.binding || !v || v.observedHeadSha !== v.testedHeadSha || v.testedHeadSha !== v.reviewedHeadSha || !v.changedFiles.length)
                throw Error('Immutable reviewed project increment evidence missing');
            const acceptance = projectAcceptanceSchema.parse(v.projectAcceptance), bound = acceptanceBinding(r.binding);
            if (!acceptance.passed || acceptance.headSha !== v.testedHeadSha || acceptance.projectId !== bound.projectId || acceptance.contractHash !== bound.contractHash || acceptance.checks.length !== bound.scenarioNames.length || acceptance.checks.some((c, i) => !c.passed || c.name !== bound.scenarioNames[i]))
                throw Error('Original approved browser acceptance has not passed for this increment');
            for (const f of v.changedFiles)
                if (!p.spec!.allowedPaths.some(prefix => f.path === prefix || prefix.endsWith('/') && f.path.startsWith(prefix)))
                    throw Error('Coding diff escaped the approved project paths: ' + f.path);
            await finish('advance', { head: v.testedHeadSha, taskId: job!.id, verification: v, summary: m.result });
            return;
        }
        if (p.phase === 'assessment') {
            const finalRun = [...runs].reverse().find(r => r.kind === 'development' && r.outcome?.head === p.verified_sha);
            if (!finalRun?.binding || typeof finalRun.outcome?.taskId !== 'string') throw Error('Final verified task binding is missing');
            const live = await developmentPreview(await readTask(finalRun.outcome.taskId), acceptanceBinding(finalRun.binding));
            if (!live || live.headSha !== p.verified_sha) { await finish('wait', { detail: 'Final preview evidence is not currently verified; completion is withheld.' }); return; }
            const url = new URL(p.spec!.finalContract.path, live.url).href;
            if(!p.preview?.browserAcceptance?.passed)throw Error('Actual deployed browser evidence is required before completion');
            if(live.deploymentId!==p.preview.deploymentId||live.statusId!==p.preview.statusId||url!==p.preview.url){await finish('preview',{...live,url});return;}
            await finish('complete', { result: m.result + '\n\nVerified playable preview: ' + url, preview: { ...live, url }, verified_head: p.verified_sha });
            return;
        }
    }
    if (p.phase === 'approval' && p.spec) {
        await finish('spec', { spec: p.spec, baseline: await baseline(p), detail: 'Specification and repository are ready for scope approval.' });
        return;
    }
    if (p.phase === 'delivery') {
        const r = [...runs].reverse().find(r => r.kind === 'development' && r.outcome?.head === p.verified_sha);
        if (!r?.binding || typeof r.outcome?.taskId !== 'string')
            throw Error('Final project receipt unavailable');
        const preview = await developmentPreview(await readTask(r.outcome.taskId), acceptanceBinding(r.binding));
        if (!preview) {
            await finish('wait', { detail: 'Waiting for the target repository’s successful same-commit private Preview deployment. Local browser success is not deployed completion.' });
            return;
        }
        await finish('preview', { ...preview, url: new URL(p.spec!.finalContract.path, preview.url).href });
        return;
    }
    if(p.phase==='browser_check'){
        if(!p.preview||p.preview.headSha!==p.verified_sha)throw Error('Head-bound Preview candidate unavailable');
        try{
            const result=await verifyDeployedPreview(p.preview,p.spec!.finalContract,p.id);
            if(result.passed){await finish('browser',result);return;}
            const failures=result.checks.filter(c=>!c.passed).map(c=>c.name+': '+c.detail).join('\n');
            const attempts=runs.filter(r=>r.kind==='development'&&r.milestone_index===p.spec!.milestones.length-1).length;
            await finish(p.cycles<p.max_cycles&&attempts<2?'retry':'block',{detail:'Actual deployed browser acceptance failed. Repair the unmet original requirements: '+failures});
        }catch(error){if(error instanceof PreviewAccessUnavailable){await finish('block',{detail:error.message});return;}throw error;}
        return;
    }
    const evidence = await milestoneEvidence(runs);
    let objective: string;
    let projectEvidence: unknown;
    if (p.phase === 'research')
        objective = bounded(`${source}\n\nPHASE: Research only; this is not project completion. Find primary-source rules, APIs and constraints needed for this exact outcome. Do not invent requirements. Identify edition/version ambiguities or missing material decisions as essential clarification. Give concise source-supported findings in at most 700 words. Do not implement or change repositories.`);
    else if (p.phase === 'specification') {
        const research=[...evidence].reverse().find(e=>e.phase==='research'&&e.missionStatus==='completed'&&!e.evidence?.superseded);
        if(!research?.result)throw Error('Latest reviewed research is unavailable for specification');
        const previous=[...evidence].reverse().find(e=>e.phase==='development'&&e.evidence?.head===p.verified_sha);
        const v=previous?.evidence?.verification as {changedFiles?:Array<{path:string;status?:string;patch?:string}>}|undefined;let bytes=0;
        projectEvidence=p.verified_sha?{priorVerifiedImplementation:{head:p.verified_sha,baseline:p.baseline_sha,changedFiles:(v?.changedFiles??[]).slice(0,20).map(f=>{const include=typeof f.patch==='string'&&bytes+f.patch.length<=4000;if(include)bytes+=f.patch!.length;return{path:f.path,status:f.status,...(include?{patch:f.patch}:{patchOmitted:true})};}),omittedFileCount:Math.max(0,(v?.changedFiles?.length??0)-20),note:'Bounded planning evidence only; original requirements remain authoritative and native coding reads the complete inherited commit.'}}:undefined;
        objective = bounded(`${source}\n\nREVIEWED RESEARCH:\n${research.result}\n\nProduce ONLY the requested project specification JSON, not code. Preserve every original requirement. Plan one to six cumulative coding milestones. Each milestone needs a phase-specific real browser contract for that increment; the final milestone contract MUST equal finalContract and cover the entire integrated original goal, including all required AI, human play, persistence and backend behavior. Earlier contracts may test partial milestones; they never replace the final requirements. Use isolated app/source/test paths, no dependencies/secrets/production resources. Include concrete DOM selectors and expected exact rendered states, interaction sequences, invalid-action boundaries and reload behavior as appropriate. Each scenario must assert actual application state. Output {name,summary,requirements,allowedPaths,milestones:[{title,instruction,contract:{path,scenarios:[{name,steps:[{action,selector?,value?,path?}]}]}}],finalContract}. Actions: goto(path), click(selector), fill(selector,value), expectVisible(selector), expectText(selector,value). At most 100 steps per contract, 20 scenarios, each scenario at least one assertion. All navigation local paths only. allowedPaths must be narrow filenames or isolated directory prefixes ending in /. Do not scope the entire Katie application. Return a complete specification satisfying the original user outcome; ambiguities require clarification rather than guessed gameplay.`);
    }
    else if (p.phase === 'development') {
        if (!p.spec || !p.approved_hash || p.approved_hash !== p.approval_hash)
            throw Error('Project scope not approved');
        const stage = p.spec.milestones[p.milestone_index];
        if (!stage)
            throw Error('Approved milestone missing');
        objective = bounded(`${source}\n\nAPPROVED SPECIFICATION:\n${JSON.stringify({ summary: p.spec.summary, requirements: p.spec.requirements, allowedPaths: p.spec.allowedPaths })}\n\nCURRENT CODING MILESTONE ${p.milestone_index + 1}/${p.spec.milestones.length}:\n${stage.title}\n${stage.instruction}\n\nAPPROVED BROWSER CONTRACT:\n${JSON.stringify(stage.contract)}\n\nPREVIOUS VERIFIED HEAD: ${p.verified_sha ?? p.baseline_sha}. The server supplies the exact immutable starting commit. Preserve previous increments and implement this stage completely.\n\nUnresolved findings: ${p.detail ?? 'None.'}\nDo not merge, publish production, change dependencies/secrets/services, or touch files outside the approved paths. Deliver a draft PR through the existing independent test/review/browser pipeline. This is milestone completion, not a claim that later stages are done.`);
    }
    else if (p.phase === 'assessment') {
        const final = [...evidence].reverse().find(e => e.phase === 'development');
        projectEvidence = { milestones: evidence.map(e => ({ phase: e.phase, index: e.index, status:e.missionStatus, head:e.evidence?.head })), approvedFinalContract:p.spec!.finalContract,approvedScopeHash:p.approved_hash,finalIntegratedEvidence: final?.evidence ?? null, preview: p.preview };
        objective = bounded(`${source}\n\nFINAL WHOLE-PROJECT DELIVERY: Independently check the ENTIRE original user outcome against all approved requirements and actual integrated evidence. A partial phase report, architecture document or loading page is not sufficient. Do not waive AI, human play, rules fidelity, persistence or backend requirements. Missing material evidence must remain blocked; do not invent test outcomes. If the complete outcome is supported, deliver the usable preview link, concise instructions, actual verified checks and any limitations.\nAPPROVED REQUIREMENTS:${JSON.stringify(p.spec!.requirements)}\nVERIFIED PREVIEW:${JSON.stringify(p.preview)}\nActual head-bound milestone and final browser evidence are provided in projectEvidence.`);
    }
    else
        throw Error('Unknown project phase');
    await finish('child', { kind: p.phase, objective, evidence: projectEvidence });
}
async function reconcileParkedDispatch() {
    const data=await projectRpc<Array<{id:string;external:Record<string,unknown>}>>('project_dispatch_recovery_candidates');
    for(const row of (data??[]) as Array<{id:string;external:Record<string,unknown>}>){
        if(typeof row.external?.projectId!=='string')continue;
        const c=await getDevelopmentProjectContext(row.id);if(!c)continue;
        const {data:p,error:pe}=await getSupabaseAdminClient().from('work_projects').select('*').eq('id',c.projectId).maybeSingle<Project>();
        if(pe||!p)continue;
        const {data:j}=await getSupabaseAdminClient().from('mission_assignments').select('mission_id').eq('id',row.id).maybeSingle<{mission_id:string}>();
        if(p.status==='running'&&p.approved_hash===c.scopeHash&&p.active_mission_id===j?.mission_id)continue;
        await reconcileDevelopment(await readTask(row.id),acceptanceBinding(c));return true;
    }
    return false;
}
export async function runProjectBatch() { const maintenance=reconcileParkedDispatch().catch(error=>{console.error('[Projects] Parked dispatch recovery failed',error instanceof Error?error.message:'Unknown failure');});try { const p = await projectRpc<Project | null>('claim_work_project'); if (!p)
    return { claimed: 0 }; try {
    await advance(p);
    return { claimed: 1, status: 'processed' };
}
catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 800) : 'Project coordination failed';
    console.error('[Projects]', { project: p.id, detail });
    await projectRpc('finish_work_project', { p_id: p.id, p_lease: p.lease, p_action: 'error', p_data: { detail } });
    return { claimed: 1, status: 'blocked' };
} } finally {await maintenance;} }
