import {projectEvidenceLimit} from './evidence-budget';
import {preflightSavedReview} from '@/lib/missions/worker';
import {verifyDeployedPreview,PreviewAccessUnavailable} from '@/lib/projects/preview';
import { Octokit } from '@octokit/rest';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import { readMission } from '@/lib/missions/store';
import { readTask } from '@/lib/agents/store';
import { developmentPreview, projectAcceptanceSchema, reconcileDevelopment, retryImmutableProjectVerification } from '@/lib/agents/development';
import { parseJSON } from '@/lib/missions/types';
import { validateProjectPlan, digest, projectPlanSchema, gameSpecificationView, canonical } from './contract';
import {gameAssessmentEvidence,jsonbTextSize} from './game-evidence';
import { projectRpc, projectRuns, milestoneEvidence, acceptanceBinding, getDevelopmentProjectContext, type Project } from './store';
export async function baseline(p: Project) { if (!p.repository_id)
    return null; const { data: r, error } = await getSupabaseAdminClient().from('repo_sync_runs').select('repository_full_name').eq('id', p.repository_id).maybeSingle<{
    repository_full_name: string;
}>(); if (error || !r || !/^[-\w.]+\/[-\w.]+$/.test(r.repository_full_name))
    throw Error('Connected target repository unavailable'); if(!(process.env.PROJECT_PREVIEW_REPOSITORIES??'').split(',').map(s=>s.trim().toLowerCase()).includes(r.repository_full_name.toLowerCase()))throw Error('This target needs an explicitly configured credential-free Preview environment before project coding can be approved'); const [owner, repo] = r.repository_full_name.split('/'); const gh = new Octokit({ auth: process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT ?? process.env.GH_TOKEN, request: { timeout: 15000 } }); const m = await gh.repos.get({ owner, repo }); if (m.data.default_branch !== 'main')
    throw Error('The connected project target must use the existing main-branch autonomous workflow'); const user = await gh.users.getAuthenticated(); if (user.data.type !== 'User' || m.data.owner.type !== 'User' || user.data.login.toLowerCase() !== owner.toLowerCase())
    throw Error('The project target must be owned by the existing authenticated human GitHub owner'); const workflow = await gh.repos.getContent({ owner, repo, path: '.github/workflows/autonomous-development.yml', ref: 'main' }); if (Array.isArray(workflow.data) || !('content' in workflow.data))
    throw Error('Target project workflow is unavailable'); const source = Buffer.from(workflow.data.content, 'base64').toString('utf8'); if (!source.includes('project-browser-check.mjs') || !source.includes('projectAcceptance'))
    throw Error('The target repository needs the versioned project execution integration before coding can be approved');
 if(p.profile==='game'){
  if(!source.includes('project-game-check.mjs')||!source.includes('project-game-rules.mjs'))throw Error('The target repository needs the versioned game model/context integration before coding can be approved');
  const [contextTool,ciTool,modelTool,rulesTool]=await Promise.all(['scripts/project-context.mjs','scripts/project-ci.mjs','scripts/project-game-check.mjs','scripts/project-game-rules.mjs'].map(path=>gh.repos.getContent({owner,repo,path,ref:'main'}))).catch(()=>{throw Error('Target requires all versioned game verification tools before coding approval');});
  const content=(file:typeof contextTool)=>{if(Array.isArray(file.data)||!('content' in file.data))throw Error('Target game verification tools unavailable before coding approval');return Buffer.from(file.data.content,'base64').toString('utf8');};
  if(!/export const GAME_PROJECT_CONTEXT_VERSION\s*=\s*1\s*;/.test(content(contextTool))||!content(ciTool).includes('checkGameModel(context,root,dependencies)')||!content(modelTool).includes('runGameModelAcceptance')||!content(rulesTool).includes('export function validateGameAcceptance')||!content(rulesTool).includes('export function runGameModelAcceptance'))throw Error('Target game acceptance tools are incompatible; upgrade the connected target before coding approval');
 }
 if(p.verified_sha&&p.baseline_sha)return p.baseline_sha; const b = await gh.repos.getBranch({ owner, repo, branch: 'main' }); return b.data.commit.sha; }
function bounded(text: string) { if (text.length > 12000)
    throw Error('Project milestone context exceeds its bounded input. Narrow the specification; original requirements have not been truncated.'); return text; }
// Reduce only framework boilerplate when needed; the original brief is always
// present verbatim in the bounded mission objective and every reviewer pass.
function boundedGameSpecification(detailed:string,original:string,game:boolean){
 if(detailed.length<=12000)return detailed;
 const compact=`${original}\n\nPHASE: Specification only. Independently reviewed research is in projectEvidence.reviewedResearch. Do not implement code. Preserve EVERY original user requirement and unresolved decision. Return complete JSON {name,summary,requirements,allowedPaths,milestones:[{title,instruction,contract:{path,scenarios:[{name,steps:[{action,selector?,value?,path?}]}]}}],finalContract} with 1–6 cumulative milestones. Allowed paths must be isolated app/source/test paths. Every browser scenario needs observable assertions. Actions: goto,click,fill,expectVisible,expectText. Keep at most 20 scenarios and 100 steps per contract. Each scenario starts in a fresh browser context and tests persistence within the same context. finalContract proves the entire original goal, not merely one milestone. ${game?'Include game:{enginePath,rules,acceptance} with stable lowercase rule/source/invariant IDs, explicit verified/interpretation/unresolved statuses and provenance, all approved rules covered by model/browser acceptance scenarios. Model steps must state exact expected states; browser scenarios must equal finalContract.scenarios. Block material gameplay ambiguities rather than invent rules. Pure transition(state,action) engine required.':''} All server validation and approval gates remain mandatory.`;
 return bounded(compact);
}


export async function buildSpecificationEvidence(p:Project,evidence:Awaited<ReturnType<typeof milestoneEvidence>>,source:string){
    const game=p.profile==='game';
    let projectEvidence:unknown;
    const research=[...evidence].reverse().find(e=>e.phase==='research'&&e.missionStatus==='completed'&&!e.evidence?.superseded);
    if(!research?.result)throw Error('Latest reviewed research is unavailable for specification');
    const previous=[...evidence].reverse().find(e=>e.phase==='development'&&e.evidence?.head===p.verified_sha);
    const v=previous?.evidence?.verification as {changedFiles?:Array<{path:string;status?:string;patch?:string}>}|undefined;let bytes=0;
    projectEvidence=p.verified_sha?{priorVerifiedImplementation:{head:p.verified_sha,baseline:p.baseline_sha,changedFiles:(v?.changedFiles??[]).slice(0,20).map(f=>{const include=typeof f.patch==='string'&&bytes+f.patch.length<=4000;if(include)bytes+=f.patch!.length;return{path:f.path,status:f.status,...(include?{patch:f.patch}:{patchOmitted:true})};}),omittedFileCount:Math.max(0,(v?.changedFiles?.length??0)-20),note:'Bounded planning evidence only; original requirements remain authoritative and native coding reads the complete inherited commit.'}}:undefined;
    projectEvidence={...(projectEvidence as Record<string,unknown>??{}),...(game?{projectProfile:'game'}:{}),reviewedResearch:{text:research.result,reviewedMissionId:research.evidence?.reviewedMissionId??null,phase:'research'}};
    if(game){
        // Compact, trusted findings from the failed revision accompany the
        // next specification. The full prior draft, review and token charges
        // remain saved in their original mission.
        const {data:recovery,error:recoveryError}=await getSupabaseAdminClient()
          .from('project_events').select('data').eq('project_id',p.id)
          .eq('event','game_revision_timeout_recovered').order('created_at',{ascending:false}).limit(1);
        if(recoveryError)throw Error('Saved game revision recovery evidence unavailable');
        const note=((recovery??[]) as Array<{data?:{findings?:string;sourceMissionId?:string}}>)[0]?.data;
        if(note&&typeof note.findings==='string')
            projectEvidence={...(projectEvidence as Record<string,unknown>),recoveryReview:{sourceMissionId:note.sourceMissionId,findings:note.findings.slice(0,2200),instruction:'Correct these independent review findings. Full prior evidence remains saved; do not repeat research or assume approval.'}};
    }
    if(game){
        const {data:events,error}=await getSupabaseAdminClient().from('project_events')
          .select('data').eq('project_id',p.id).eq('event','game_rule_coverage_recovered')
          .order('created_at',{ascending:false}).limit(1);
        if(error)throw Error('Game coverage recovery evidence unavailable');
        const recovered=((events??[]) as Array<{data?:{sourceMissionId?:string;findings?:string;revisionJobId?:string}}>)[0]?.data;
        if(recovered?.revisionJobId){
            const {data:prior,error:pe}=await getSupabaseAdminClient().from('mission_assignments')
              .select('result').eq('id',recovered.revisionJobId).maybeSingle<{result:{rejectedSpecification?:string}|null}>();
            if(pe)throw Error('Saved rejected game draft unavailable');
            let draft:unknown=null;
            try{
                const raw=prior?.result?.rejectedSpecification;
                if(raw){
                    const source=projectPlanSchema.parse(JSON.parse(raw));
                    const view=gameSpecificationView(source);
                    if(canonical(view).length<=20000)draft=view;
                }
            }catch{/* Preserve unparseable original in its durable mission. */}
            projectEvidence={...(projectEvidence as Record<string,unknown>),
              recoveryCoverage:{sourceMissionId:recovered.sourceMissionId,findings:recovered.findings,
                rejectedDraft:draft,instructions:'contractRef and stepsRef are lossless server-resolved references to finalContract; return fully expanded JSON. Preserve valid scenarios, add real observable or model-based proof for missing rule IDs, never invent rules or user decisions; require fresh independent review.'}};
        }
    }
    if(source.length>6500)projectEvidence={...(projectEvidence as Record<string,unknown>),originalUserOutcome:source};
    return projectEvidence;
}

async function advance(p: Project) {
    const finish = (action: string, data: Record<string, unknown> = {}) => projectRpc<boolean>('finish_work_project', { p_id: p.id, p_lease: p.lease, p_action: action, p_data: data });
    const runs = await projectRuns(p.id);
    const game=p.profile==='game';
    const source = `ORIGINAL USER OUTCOME (must remain authoritative):\n${p.objective}\n${p.clarifications}`;
    const evidenceBrief=source.length>6500;
    const reviewableSource=evidenceBrief?'ORIGINAL USER OUTCOME (authoritative verbatim text in projectEvidence.originalUserOutcome, which MUST be read in full and checked during independent review).':source;
    const gamePlanning=game?'\nGAME SPECIALIST CONTRACT: Identify explicit edition and original versus reproduction. Preserve rule provenance, approved interpretations, unresolved mechanics, turn/phase transitions, legal/illegal actions, terminal states, player modes, persistence, and reset. Do not invent missing rules. Original user-defined games may use the original brief as their primary rules source. Architecture must separate a pure deterministic transition(state,action) engine from UI/persistence/bot/network behavior.':'';
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
            // Verification infrastructure failures must not spend another coding
            // cycle. Re-dispatch independent tests/review for the exact saved PR
            // head; keep the original mission and approval.
            if(p.phase==='development'&&m.status==='blocked'){
                const failedDevelopment=current.jobs.find(j=>j.role==='development'&&j.status==='failed');
                if(failedDevelopment){
                    try {
                        const task=await readTask(failedDevelopment.id);
                        if(task.external?.dispatchRejected===true){await finish('block',{detail:task.details??'GitHub rejected coding dispatch before acceptance; original scope retained.'});return;}
                        if(await retryImmutableProjectVerification(task,p))return;
                    } catch(error) {
                        console.error('[Projects] Immutable re-verification unavailable',error instanceof Error?error.message:'Unknown error');
                        // Do not silently create another coding attempt on
                        // verification dispatch failure.
                    }
                }
            }
            const failedCoordinator=current.jobs.find(j=>j.status==='failed'&&j.role!=='development');
            if(failedCoordinator){await finish('block',{detail:'The '+p.phase+' worker failed before its result could be verified: '+String(failedCoordinator.result?.detail??failedCoordinator.detail??'Unknown coordinator failure')+'. Prior work and charges remain saved; this is not evidence that the implementation needs another coding job.'});return;}
            const reviews = current.jobs.filter(j => j.role === 'review');
            const findings = reviews.flatMap(j => {
                const r = j.result as Record<string, unknown> | null | undefined;
                const structured = r?.findings;
                if (Array.isArray(structured)) return structured.map(f => typeof f === 'string' ? f : (f && typeof f === 'object' && typeof (f as Record<string,unknown>).detail === 'string' ? (f as Record<string,unknown>).detail as string : '')).filter(Boolean);
                // Independent reviewer receipts store failed acceptance checks,
                // not necessarily a single summary. Give repairs the exact failed
                // evidence rather than asking the implementer to re-research.
                if (Array.isArray(r?.checks)) {
                    const failed = r.checks.filter(c => c && typeof c === 'object' && (c as Record<string,unknown>).passed === false)
                        .map(c => String((c as Record<string,unknown>).id ?? 'check') + ': ' + String((c as Record<string,unknown>).evidence ?? 'Failed acceptance check'));
                    if (failed.length) return failed;
                }
                return typeof r?.summary === 'string' ? [r.summary] : j.detail ? [j.detail] : [];
            }).map(s => s.trim()).filter(Boolean);
            const notes = findings.join('\n');
            const currentStage = p.spec?.milestones[Math.min(p.milestone_index, (p.spec?.milestones.length ?? 1)-1)];
            const attempts = runs.filter(r => r.kind === 'development' && r.milestone_index === p.milestone_index).length;
            // Never turn a blocked research/specification/review coordination failure
            // into another coding job. Only a failed development deliverable with
            // actionable reviewer findings is eligible for one targeted repair.
            if (p.phase === 'development' && p.approved_hash && currentStage && findings.length &&
                p.cycles < p.max_cycles && attempts < 2 && current.jobs.some(j => j.role === 'development' && j.status === 'completed')) {
                await finish('retry', { detail: 'TARGETED REPAIR ONLY. Preserve approved scope and verified prior milestones. Fix these reviewer findings: ' + notes, findings, failed_mission: m.id });
                return;
            }
            if(p.phase==='research'&&await projectRpc<boolean>('recover_project_research',{p_id:p.id,p_lease:p.lease}))return;
            await finish('block', { detail: 'A project milestone is blocked: ' + (notes || m.detail || m.status) });
            return;
        }
        if (m.status !== 'completed') {
            await finish('wait');
            return;
        }
        if (p.phase === 'research') {
            // The database's reviewed-mission completion gate is necessary but
            // research also needs a substantive saved result before progression.
            if (typeof m.result !== 'string' || !m.result.trim()) {
                await finish('block', { detail: 'Research mission reported completion without a reviewed research artifact. No new research job was scheduled; inspect its review evidence.' });
                return;
            }
            await finish('advance', { result: m.result, reviewedMissionId: m.id });
            return;
        }
        if (p.phase === 'specification') {
            const spec = validateProjectPlan(parseJSON(m.result ?? ''));
            if(game&&!spec.game)throw Error('Game specification requires source-grounded rules and registered model/browser acceptance');
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
    // A finite project needs a progress watchdog before authorizing another
    // expensive child mission. Superseded scope revisions are not failed work.
    const attempts = runs.filter(r => r.kind === p.phase && r.milestone_index === p.milestone_index &&
        !r.outcome?.superseded);
    if (attempts.length >= 3 && !p.active_mission_id) {
        const states = await Promise.all(attempts.slice(-3).map(async r => (await readMission(r.mission_id)).mission.status));
        if (states.every(status => status === 'blocked' || status === 'stopped')) {
            await finish('block', { detail: 'Progress watchdog: three consecutive failed '+p.phase+' attempts at the same milestone. Completed evidence and consumed budgets are preserved; an explicit diagnosis or revised scope is required before any further work.' });
            return;
        }
    }
    // Do not spawn more research or planning jobs when cumulative spend has
    // consumed the aggregate budget. SQL reservations remain authoritative.
    const { data: spend, error: spendError } = await getSupabaseAdminClient().from('agent_missions')
        .select('actual_tokens,reserved_tokens').eq('project_id',p.id);
    if (spendError) throw Error('Cannot verify cumulative project budget');
    // A mission's reserved_tokens already includes its settled actual_tokens.
    // Match reserve_mission_call's canonical budget accounting (max per mission),
    // rather than double-charging every completed call.
    const charged = ((spend ?? []) as Array<{actual_tokens: number | null;reserved_tokens:number | null}>).reduce((total: number, m) => total +
        Math.max(0, Number(m.actual_tokens ?? 0), Number(m.reserved_tokens ?? 0)), 0);
    if (p.token_allowance - charged < 8000) {
        await finish('block', { detail: 'Aggregate project token budget has fewer than 8,000 uncommitted tokens. Previous work is retained; a new mission is not authorized.' });
        return;
    }
    const evidence = await milestoneEvidence(runs);
    let objective: string;
    let projectEvidence: unknown;
    if (p.phase === 'research')
        objective = bounded(`${source}\n\nPHASE: Research only; this is not project completion. ${gamePlanning} Find primary-source rules, APIs and constraints needed for this exact outcome. Do not invent requirements. Identify edition/version ambiguities or missing material decisions as essential clarification. Give concise source-supported findings in at most 700 words. Do not implement or change repositories.`);
    else if (p.phase === 'specification') {
        projectEvidence=await buildSpecificationEvidence(p,evidence,source);
        // Keep the complete independently reviewed research as structured evidence,
        // not a second copy inside the 12 KB mission instruction. The original
        // user objective remains unchanged and authoritative.
        objective = boundedGameSpecification(`${reviewableSource}\n\nREVIEWED RESEARCH: The complete independently reviewed research is supplied in projectEvidence.reviewedResearch; use it without repeating it in the instruction.\n\n${gamePlanning} Produce ONLY the requested project specification JSON, not code. Preserve every original requirement. Plan one to six cumulative coding milestones. Each milestone needs a phase-specific real browser contract for that increment; the final milestone contract MUST equal finalContract and cover the entire integrated original goal, including all required AI, human play, persistence and backend behavior. Earlier contracts may test partial milestones; they never replace the final requirements. Use isolated app/source/test paths, no dependencies/secrets/production resources. Include concrete DOM selectors and expected exact rendered states, interaction sequences, invalid-action boundaries and reload behavior as appropriate. Each scenario must assert actual application state. Each scenario starts in a fresh browser context with empty application storage; navigation within the same scenario preserves localStorage, so test persistence with multiple steps in that one scenario. Output {name,summary,requirements,allowedPaths,milestones:[{title,instruction,contract:{path,scenarios:[{name,steps:[{action,selector?,value?,path?}]}]}}],finalContract}. Actions: goto(path), click(selector), fill(selector,value), expectVisible(selector), expectText(selector,value). At most 100 steps per contract, 20 scenarios, each scenario at least one assertion. All navigation local paths only. allowedPaths must be narrow filenames or isolated directory prefixes ending in /. Do not scope the entire Katie application. ${game?'Also include game:{enginePath,rules,acceptance}. The final milestone executes all registered model scenarios; earlier browser contracts may cover partial increments. enginePath must be a self-contained .ts or .mjs file exporting transition(state,action); no imports or side effects. rules={schemaVersion:1,game:{id,title,edition,kind:"original"|"reproduction"},sources:[{id,kind:"user"|"official"|"authorized_reference"|"other",reference,edition?}],rules:[{id,description,category,status:"verified"|"approved_interpretation"|"unresolved",sourceIds:[]}],unknowns:[{id,question,status:"open"|"resolved",blocking:boolean,ruleIds:[existingRuleId],decisionSourceId?}],invariants:[{id,description,ruleIds:[]}],stateModel:{initialState,phases:[]}}. acceptance={schemaVersion:1,gameId,scenarios:[{id,description,kind:"model"|"browser",ruleIds:[],invariantIds:[],steps:[]}]}. Every approved rule must have scenario coverage. Include both model and browser scenarios. Model steps are {action:{type,...},expectedState:<exact full state>}; each scenario starts at initialState. Browser steps use the existing browser actions. finalContract.scenarios MUST exactly equal browser scenarios mapped to {name:id,steps}. For unknowns, use [] if none; every nonempty entry MUST include question, status, blocking, nonempty ruleIds referencing existing rules, and decisionSourceId for resolved entries. Do not substitute description for question. Nonblocking unknowns cannot replace decisions affecting game mechanics. Resolve blocking unknowns before coding. Use stable lowercase IDs.':''} Return a complete specification satisfying the original user outcome; ambiguities require clarification rather than guessed gameplay.`,reviewableSource,game);
    }
    else if (p.phase === 'development') {
        if (!p.spec || !p.approved_hash || p.approved_hash !== p.approval_hash)
            throw Error('Project scope not approved');
        const stage = p.spec.milestones[p.milestone_index];
        if (!stage)
            throw Error('Approved milestone missing');
        if(game){
            // The approved game and browser contract already have durable,
            // server-validated homes. Never repeat the entire browser step
            // matrix inside the 12 KB mission objective: large but valid game
            // contracts previously blocked the transition into development.
            // Native coding loads the exact saved approved browser contract
            // from project_runs.binding, independently of model-authored text.
            projectEvidence={
                gameContract:p.spec.game,
                approvedMilestone:{
                    index:p.milestone_index,
                    total:p.spec.milestones.length,
                    title:stage.title,
                    instruction:stage.instruction,
                    requirements:p.spec.requirements,
                    allowedPaths:p.spec.allowedPaths,
                    browserContractHash:digest(stage.contract),
                    browserScenarioNames:stage.contract.scenarios.map(s=>s.name),
                    browserContractSource:'server-owned project_runs.binding.contract',
                    previousVerifiedHead:p.verified_sha??p.baseline_sha,
                    unresolvedFindings:p.detail??null
                },
                approvedScopeHash:p.approved_hash
            };
            objective=bounded(`${reviewableSource}\n\nAPPROVED DEVELOPMENT MILESTONE ${p.milestone_index+1}/${p.spec.milestones.length}. The complete approved requirements, implementation instructions, narrow paths, verified base SHA, original game rules, and scenario names are saved in projectEvidence.approvedMilestone and projectEvidence.gameContract. The EXACT approved phase-specific browser contract, including every expected assertion and step, is bound by the trusted controller at project_runs.binding.contract for this development job. Follow these authoritative saved records; do not invent rules, skip scenarios, or take a previous mission as proof of this milestone.\nDo not merge, publish production, change dependencies/secrets/services, or touch files outside approved paths. Deliver a tested, independently reviewed draft PR with immutable commit and bound browser/model verification. Do not claim later stages are complete.`);
        }else{
            objective = bounded(`${source}\n\nAPPROVED SPECIFICATION:\n${JSON.stringify({ summary: p.spec.summary, requirements: p.spec.requirements, allowedPaths: p.spec.allowedPaths })}\n\nCURRENT CODING MILESTONE ${p.milestone_index + 1}/${p.spec.milestones.length}:\n${stage.title}\n${stage.instruction}\n\nAPPROVED BROWSER CONTRACT:\n${JSON.stringify(stage.contract)}\n\nPREVIOUS VERIFIED HEAD: ${p.verified_sha ?? p.baseline_sha}. The server supplies the exact immutable starting commit. Preserve previous increments and implement this stage completely.\n\nUnresolved findings: ${p.detail ?? 'None.'}\nDo not merge, publish production, change dependencies/secrets/services, or touch files outside the approved paths. Deliver a draft PR through the existing independent test/review/browser pipeline. This is milestone completion, not a claim that later stages are done.`);
        }
    }
    else if (p.phase === 'assessment') {
        const final = [...evidence].reverse().find(e => e.phase === 'development');
        projectEvidence = { milestones: evidence.map(e => ({ phase: e.phase, index: e.index, status:e.missionStatus, head:e.evidence?.head })), approvedFinalContract:p.spec!.finalContract,approvedScopeHash:p.approved_hash,finalIntegratedEvidence: final?.evidence ?? null, preview: p.preview, ...(p.spec!.game?{gameRules:p.spec!.game.rules}:{}) };
        if(game)projectEvidence=gameAssessmentEvidence(p,evidence.map(e=>({phase:e.phase,index:e.index,status:e.missionStatus,head:e.evidence?.head})),final?.evidence??null);
        objective = bounded(`${game?reviewableSource:source}\n\nFINAL WHOLE-PROJECT DELIVERY: Independently check the ENTIRE original user outcome against all approved requirements and actual integrated evidence. A partial phase report, architecture document or loading page is not sufficient. Do not waive AI, human play, rules fidelity, persistence or backend requirements. Missing material evidence must remain blocked; do not invent test outcomes. If the complete outcome is supported, deliver the usable preview link, concise instructions, actual verified checks and any limitations.\nAPPROVED REQUIREMENTS:${game?'See projectEvidence.approvedRequirements, preserved in full.':JSON.stringify(p.spec!.requirements)}\nVERIFIED PREVIEW:${game?'See the full source-bound Preview receipt in projectEvidence.':JSON.stringify(p.preview)}\nActual head-bound milestone and final browser evidence are provided in projectEvidence.`);
    }
    else
        throw Error('Unknown project phase');
    if(game&&['development','assessment'].includes(p.phase))projectEvidence={...(projectEvidence as Record<string,unknown>??{}),projectProfile:'game',originalUserOutcome:source,...(p.phase==='assessment'?{approvedRequirements:p.spec!.requirements}:{})};
    // The durable SQL admission fence verifies aggregate evidence size;
    // preflight before consuming a child mission or recovery allowance.
    if(jsonbTextSize(projectEvidence??{})>projectEvidenceLimit(p.profile,p.phase))throw Error('Project evidence exceeds bounded context; original requirements retained without starting a child');
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
async function reconcileBlockedGameRevisions(){
    // Recover the same project at specification, not a new research or coding
    // mission. PostgreSQL atomically enforces the old verdict, timeout cause,
    // original aggregate budget, milestone limit and one-recovery ceiling.
    const db=getSupabaseAdminClient();
    let offset=0;
    // Stable keyset pagination ensures two older unrecoverable jobs never starve
    // a later eligible project, even as concurrent recoveries alter statuses.
    for(;;){
        const q=db.from('work_projects').select('*')
          .eq('status','blocked').eq('profile','game').eq('phase','specification')
          .order('id',{ascending:true}).range(offset,offset+29);
        const {data,error}=await q;
        if(error)throw Error('Blocked game revision recovery index unavailable');
        const rows=(data??[]) as Project[];
        if(!rows.length)break;
        for(const p of rows){
            const authorized={p_id:p.id,p_actor:p.actor_id,p_chat:p.chat_id};
            let oversized=false;
            if(!p.active_mission_id&&/Project (?:milestone context exceeds its bounded input|evidence exceeds bounded context)/.test(p.detail??'')){
                // Use the SAME complete payload builder as actual dispatch.
                // A non-fitting payload remains pending: no RPC, wake-up event,
                // model call or success announcement is consumed.
                const source=`ORIGINAL USER OUTCOME (must remain authoritative):\n${p.objective}\n${p.clarifications}`;
                try{
                    const evidence=await buildSpecificationEvidence(p,await milestoneEvidence(await projectRuns(p.id)),source);
                    if(jsonbTextSize(evidence)>projectEvidenceLimit(p.profile,p.phase))continue;
                    oversized=await projectRpc<boolean>('resume_oversized_game_specification',{...authorized,p_evidence:evidence});
                }catch(error){console.warn('[Projects] Specification recovery preflight unavailable',{project:p.id,detail:error instanceof Error?error.message:'Evidence unavailable'});continue;}
            }
            let reviewPreflight:Awaited<ReturnType<typeof preflightSavedReview>>|undefined;
            if(p.active_mission_id){
                const saved=await readMission(p.active_mission_id);
                const overflow=saved.jobs.filter(j=>j.role==='review'&&j.status==='failed'&&(j.result?.reviewContextOverflow===true||j.detail==='Mission evidence exceeds bounded context. Narrow the objective or deliverable.')).at(-1);
                if(overflow){reviewPreflight=await preflightSavedReview(saved,overflow);if(!reviewPreflight){
                    if(await projectRpc<boolean>('resume_incomplete_game_review',{...authorized,p_preflight:{refreshAssessment:true}}))return true;
                    continue;
                }}
            }
            const native=oversized || await projectRpc<boolean>('resume_pending_game_review',authorized) ||
              await projectRpc<boolean>('resume_incomplete_game_review',{...authorized,...(reviewPreflight?{p_preflight:reviewPreflight}:{})});
            if(native || await projectRpc<boolean>('recover_game_revision_timeout',{p_id:p.id}) || await projectRpc<boolean>('recover_game_rule_coverage',{p_id:p.id}) || await projectRpc<boolean>('recover_bounded_game_review',{p_id:p.id}) || await projectRpc<boolean>('recover_mission_credit_failure',{p_id:p.id})){
                console.info('[Projects] Saved specification work recovered within original limits',{project:p.id});
                return true;
            }
        }
        if(rows.length<30)break;
        offset+=30;
    }
    return false;
}
async function reconcileBlockedInfrastructureProjects(){
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('work_projects').select('*')
      .eq('status','blocked').eq('phase','development').order('updated_at',{ascending:false}).limit(2);
    if(error)throw Error('Blocked project recovery index unavailable');
    for(const p of (data??[]) as Project[]){
        if(!p.active_mission_id||!p.approved_hash||p.approved_hash!==p.approval_hash||new Date(p.deadline).getTime()<=Date.now())continue;
        const saved=await readMission(p.active_mission_id);
        if(saved.mission.status!=='blocked')continue;
        const failed=saved.jobs.find(j=>j.role==='development'&&j.status==='failed');
        if(!failed)continue;
        const receipt=(failed.result?.external as Record<string,unknown>|undefined)?.receipt as Record<string,unknown>|undefined;
        const checks=receipt?.checks as Record<string,unknown>|undefined;
        const setupFailure=checks?.review==='pass'&&checks?.repair==='failure';
        const browserBootstrapFailure=checks?.review==='changes_requested'&&checks?.repair==='skipped';
        if(receipt?.outcome!=='BLOCKED'||checks?.test!=='false'||(!setupFailure&&!browserBootstrapFailure))continue;
        const task=await readTask(failed.id);
        if(!browserBootstrapFailure&&typeof task.external.verificationSince==='string')continue;
        try {
            if(await retryImmutableProjectVerification(task,p)){
                console.info('[Projects] Existing project commit queued for verification-only recovery',{project:p.id,mission:p.active_mission_id});
                return true;
            }
        } catch(e){
            console.error('[Projects] Verification-only recovery failed',{project:p.id,reason:e instanceof Error?e.message:'Unknown error'});
        }
    }
    return false;
}
export async function runProjectBatch() { const maintenance=Promise.all([
    reconcileParkedDispatch().catch(error=>{console.error('[Projects] Parked dispatch recovery failed',error instanceof Error?error.message:'Unknown failure');}),
    reconcileBlockedInfrastructureProjects().catch(error=>{console.error('[Projects] Blocked verification recovery failed',error instanceof Error?error.message:'Unknown failure');}),
    reconcileBlockedGameRevisions().catch(error=>{console.error('[Projects] Game revision recovery failed',error instanceof Error?error.message:'Unknown failure');})
]);try { const p = await projectRpc<Project | null>('claim_work_project'); if (!p)
    return { claimed: 0 }; try {
    await advance(p);
    return { claimed: 1, status: 'processed' };
}
catch (error) {
    const detail = error instanceof Error ? ('Project coordination error: '+error.name+'; Chromium diagnostic tail: '+error.message.slice(-1550)).slice(0,1800) : 'Project coordination failed';
    console.error('[Projects]', { project: p.id, detail });
    await projectRpc('finish_work_project', { p_id: p.id, p_lease: p.lease, p_action: 'error', p_data: { detail } });
    return { claimed: 1, status: 'blocked' };
} } finally {await maintenance;} }
