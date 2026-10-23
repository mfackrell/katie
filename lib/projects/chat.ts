import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import type { Message } from '@/lib/types/chat';
import { projectForChat, projectRpc, type Project } from './store';
import { projectId, projectMessage } from './contract';
/** Explicit instruction to modify Katie's own connected source, never mere
 * architecture discussion, inspection, or a quoted example. */
export function selfCodeChangeIntent(text: string): boolean {
 const normalized=text.trim();
 return /^(?:please\\s+)?(?:(?:can|could|would|will) you\\s+(?:please\\s+)?)?(?:fix|modify|edit|change|update|implement|repair|refactor)\\b/i.test(normalized)
   && /\\b(?:your|katie(?:'s)?|your own)\\b/i.test(normalized)
   && /\\b(?:repo(?:sitory)?|github|source code|codebase|routing code|backend code|implementation)\\b/i.test(normalized)
   && !/\\b(?:don't|do not|never|without changing|read.only|only inspect|just review)\\b/i.test(normalized);
}
export function startProjectIntent(text: string) {
 if(selfCodeChangeIntent(text))return true;
 const direct=/^\s*(?:please\s+)?(?:(?:can|could|would|will) you\s+(?:please\s+)?)?(?:build|create|develop|recreate|re-create|make|implement|launch|start)\b/i.test(text);
 const desire=/^\s*I (?:want|need|would like)\b/i.test(text) && !/^.{0,100}\b(?:explain|understand|learn|discuss|describe|whether|capable|how to)\b/i.test(text.split(/[.!?]\s/)[0]);
 const artifact=/^(?:please\s+)?(?:(?:can|could|would|will) you\s+)?(?:I (?:want|need|would like)(?: you to)?|create|make|develop|prepare|write|give|provide)\s+(?:me\s+)?(?:(?:a|an|the|project|technical|design|status)\s+)*(?:summary|report|explanation|overview|proposal|plan|architecture|tutorial|guide|analysis)\b/i.test(text);
 return !artifact && (direct||desire) && /\b(?:browser|website|web app|application|app|game|dashboard|portal|software|program|API)\b/i.test(text) && !/^.{0,80}\b(?:do not|don't|never|not asking you to)\s+(?:want to |you to )?(?:build|create|develop|make|implement|start)\b/i.test(text);
}
export function gameProjectIntent(text:string) {
 const dataArtifact=/\b(?:dashboard|tracker|analytics|portal|catalog|store|website|site|collection|library|blog|directory|forum|wiki|app|application|software)\b/i.test(text);
 const forwardProduct=/\bgames?\s+(?:sales?|analytics|reviews?|catalogs?|inventory|statistics|collection|library|tracking|news|prices?)\b/i.test(text)&&dataArtifact;
 const reverseCatalog=/\b(?:catalogs?|collection|library|inventory|directory|sales|analytics|statistics)\s+(?:of|for|about)\b.{0,80}\bgames?\b/i.test(text);
 const reverseReview=/\b(?:reviews?|news|price)\s+(?:site|website|blog|app|portal)\s+(?:for|of|about|covering)\b.{0,80}\bgames?\b|\b(?:blog|site|website|app)\s+(?:reviewing|covering)\b.{0,80}\bgames?\b/i.test(text);
 const dataProduct=forwardProduct||reverseCatalog||reverseReview;
 const commands=[...text.matchAll(/\b(?:build|create|develop|recreate|re-create|make|want|need|would like)\s+((?:[\w×'-]+\s+){0,10})games?\b(?=\s*(?:[.!?:,;]|$|\b(?:with|where|that|in|as|for|called|named)\b))/gi)];
 const primaryGame=commands.some(m=>!/(?:do not|don't|never)\s*$/i.test(text.slice(0,m.index))&&!/\b(?:app|application|software|website|site|catalog|library|blog|store|portal|dashboard|tracker|reviews?|collection|directory|forum|wiki)\b/i.test(m[1]));
 const playable=/\bplayable\s+(?:(?:browser|board|card|video|turn-based|strategy|puzzle|multiplayer)\s+)?games?\b|\bmake (?:it|this|that) (?:a |the )?games?\b/i.test(text);
 const appForGame=/\b(?:app|application|software)\s+(?:for|as|to play)\s+(?:a |the )?(?:[\w-]+ )?games?\b(?=\s*(?:[.!?:,;]|$|\b(?:with|where|that|in|as|for|called|named)\b))/i.test(text);
 const genre=/\b(?:browser|board|card|video|turn[- ]based|strategy|puzzle|multiplayer)\s+games?\b/i.test(text);
 const recreation=/\b(?:recreate|re-create|replicate)\b/i.test(text)&&genre&&!dataProduct;
 return primaryGame||playable||appForGame||recreation;
}
export const followupProjectIntent = (text: string) => /^(?:please\s+)?(?:build|make|create|implement|do|start)(?:\s+(?:that|it|this|the project))?[.!\s]*$/i.test(text.trim());
const actionText = (text:string) => text.trim().replace(/^(?:actually|also|no|okay|ok)[,:]?\s+/i,'').replace(/^please\s+/i,'').replace(/^(?:can|could|would|will) (?:you|we)\s+(?:please\s+)?/i,'');
const amendmentIntent = (text:string) => /^(?:add|change|amend|revise|update|include|remove|support|enable|use|make|retain|keep|preserve|ensure|require|avoid|prevent|fix|allow|stop)\b|^(?:also|actually|instead|one more thing|I (?:want|need|would like|would prefer))\b/i.test(actionText(text));
function projectControl(text:string):'pause'|'stop'|'resume'|null {
 const t=actionText(text);if(/^(?:do not|don't) (?:continue|proceed|keep working|keep going|do (?:any )?more work|do (?:it|that|this))\b|^(?:hold off|hold on|wait)(?:\b|$)/i.test(t))return 'pause';const match=/^(pause|stop|cancel|halt|abort|quit|resume|continue)\b\s*(.*)$/i.exec(t);if(!match)return null;
 const tail=match[2].replace(/[.!?]+$/,'').trim().replace(/^(?:all|any|any more|all of the)\s+/i,'');
 const directed=!tail||/^(?:(?:working|work)(?: on)?\s+)?(?:(?:this|the|my)\s+)?(?:project|work|working|coding|building|development|execution|research|investigating|jobs?|tasks?|agents?)\b/i.test(tail)||/^(?:now|right now|for now|please|immediately|it|this|that)(?:\b|$)/i.test(tail);
 if(!/resume|continue/i.test(match[1])){if(!directed)return null;return /pause/i.test(match[1])?'pause':'stop';}
 return directed?'resume':null;
}
/** Stopping already-bound work must remain available during task ambiguity. */
export function isProjectStopIntent(text: string): boolean {
 const control = projectControl(text);
 return control === 'stop' || control === 'pause';
}
export function referencedProjectBrief(history:Message[]):string|null {
 const turns=history.map((m,index)=>({m,index})).filter(({m})=>m.role==='user'&&!followupProjectIntent(m.content)&&!projectControl(m.content)&&!/^(?:yes|no|ok(?:ay)?|thanks|thank you|proceed|go ahead|approved?)[.!\s]*$/i.test(m.content.trim()));
 const anchors=turns.filter(({m})=>m.content.trim().length>0&&/\b(?:browser|website|web app|application|app|game|software|portal)\b/i.test(m.content)&&(startProjectIntent(m.content)||/\bI (?:want|need|would like)\b/i.test(m.content)&&!/^\s*I (?:want|need|would like)\s+(?:(?:a|an|the|project|technical|status)\s+)*(?:summary|report|explanation|overview|plan|tutorial|guide)\b/i.test(m.content)));
 if(!anchors.length)return null;
 const anchor=anchors[0];
 for(const next of anchors.slice(1))if(!/^(?:for (?:the |this )?(?:browser )?(?:game|app|project|website)|also|and|one more thing)\b|\b(?:also|in addition|for (?:the|this|that) (?:game|app|project|website))\b|\b(?:the|this|that) (?:game|app|project|website)\s+(?:should|must|needs?|requires?)\b/i.test(next.m.content))return null;
 const followups=turns.filter(t=>t.index>anchor.index);
 if(!followups.length)return anchor.m.content;
 const identity=(t:{m:Message;index:number})=>t.m.id??'user-turn-'+(t.index+1);
 return 'ORIGINAL USER BRIEF ['+identity(anchor)+']:\n'+anchor.m.content+'\n\nSAVED USER FOLLOW-UPS (in conversation order; questions are context, not permission to expand this project):\n'+followups.map(t=>'USER MESSAGE ['+identity(t)+']:\n'+t.m.content).join('\n\n');
}
const marker = /<!-- katie-project-status:[a-f0-9-]+:([^ ]+) -->/;
export async function handleProjectChat(input: {
    actorId: string;
    chatId: string;
    message: string;
    activeRepoId?: string;
    /** Source-validated semantic admission from the shared control plane. */
    softwareBuildIntent?: boolean;
}, requestId: string, history: Message[], tracked: boolean): Promise<string | null> {
    const text = input.message.trim(), pending = history.some(m => m.role === 'assistant' && marker.test(m.content) && !['completed', 'stopped'].includes(m.content.match(marker)![1]));
    const start = startProjectIntent(text), follow = followupProjectIntent(text), control = /\b(?:project|progress|status|pause|stop|resume|continue|approve|game|edition|requirement|keyboard|multiplayer)\b|^go ahead|how.{0,12}going/i.test(text);
    if (!pending && !start && !follow && !control && !projectControl(text) && !amendmentIntent(text))
        return null;
    const p = await projectForChat(input.actorId, input.chatId);
    const reply = (p: Project, body: string) => projectMessage(p.id, p.status, body);
    const mutate = async (action: string, opts: Record<string, unknown> = {}) => projectRpc<Project>('control_work_project', { p_id: p!.id, p_actor: input.actorId, p_chat: input.chatId, p_action: action, ...opts });
    if (p && !['completed', 'stopped'].includes(p.status)) {
        // Explicit non-scope progress notes must never cancel reviewed research,
        // invalidate a saved approval, or restart a development milestone.
        const note=/^(?:project note|progress note)\s*:\s*(.+)$/is.exec(text);
        if(note){
            if(!tracked)throw Error('Durable tracking is required for a project note');
            await mutate('note',{p_text:note[1]});
            return reply(p,'Saved as a project note. Existing requirements, approved work and active execution are unchanged.');
        }
        const factualContext=/^(?:project context|verified project context)\s*:\s*(.+)$/is.exec(text);
        if(factualContext){
            if(!tracked)throw Error('Durable tracking is required for project context');
            const revised=await mutate('context',{p_text:factualContext[1]});
            return reply(revised,revised.detail ?? 'Reviewed research retained; specification and approval will be refreshed.');
        }
        const command=projectControl(text);
        if(command){if(command==='resume'&&p.status==='blocked'){const recovered=await projectRpc<Project|null>('retry_project_review',{p_id:p.id,p_actor:input.actorId,p_chat:input.chatId});if(recovered)return reply(recovered,recovered.detail!);if(p.profile==='game'&&p.phase==='specification'&&await projectRpc<boolean>('retry_game_specification',{p_id:p.id,p_actor:input.actorId,p_chat:input.chatId})){const repaired=await projectForChat(input.actorId,input.chatId);if(!repaired)throw Error('Recovered project unavailable');return reply(repaired,repaired.detail??'Completing the saved specification.');}}const n=await mutate(command);return reply(n,n.detail!);}
        if (/^(?:(?:what(?:'s| is)|show(?: me)?|check|give me|tell me)(?: the)?\s+)?(?:(?:my|the|this)\s+)?(?:project\s+)?(?:status|progress)(?: of (?:the |this |my )?project)?[?!.\s]*$/i.test(text) || /^how.{0,20}(?:going|progressing)[?!.\s]*$/i.test(text) || /^is (?:the project|it) (?:done|finished)[?!.\s]*$/i.test(text))
            return reply(p, p.status === 'awaiting_approval' ? await projectRpc<string>('project_scope_proposal', {p_id:p.id}) : p.result ?? `${p.detail ?? p.status}\nCurrent phase: ${p.phase}. Coding jobs used: ${p.cycles}/${p.max_cycles}. I have not marked this project complete.`);
        const latestAssistant = [...history].reverse().find(m => m.role === 'assistant');
        const explicit = /^approve(?: this| the)? project\s+([a-f0-9]{12,64})[.!\s]*$/i.exec(text);
        const bareApproval=/^(?:yes[,\s]*)?(?:approve(?: (?:this |the )?project)?|go ahead|do (?:it|that|this)|proceed)[.!\s]*$/i.test(text);
        let contextual=false;
        if(bareApproval&&p.status==='awaiting_approval'&&p.approval_hash&&latestAssistant?.content.includes('<!-- katie-project-approval:'+p.approval_hash+' -->')){
            const saved=await projectRpc<string>('project_scope_proposal',{p_id:p.id});
            contextual=latestAssistant.content===projectMessage(p.id,p.status,saved);
        }
        if (explicit || contextual) {
            if (p.status !== 'awaiting_approval' || !p.approval_hash || explicit?.[1] && !p.approval_hash.startsWith(explicit[1]))
                return reply(p, 'That approval does not match a pending saved scope. Ask for project status to inspect the current proposal.');
            if (!tracked)
                throw Error('Durable chat request tracking is required for project approval');
            const n = await mutate('approve', { p_hash: p.approval_hash });
            return reply(n, 'Approved. I will manage the saved milestones and permitted repairs, verify the integrated result, and return it here. You can close this page.');
        }
        if (/^(?:yes[,\s]*)?(?:approve|go ahead|do (?:it|that|this)|proceed)\b/i.test(text)) return reply(p,'Please include the current approval digest shown with the exact project proposal, or reply directly after that still-current proposal. No scope was approved.');
        if(/^(?:explain|tell me|show me how|describe|compare|teach me|help me understand)\b/i.test(actionText(text)))return null;
        if(['awaiting_input','awaiting_approval'].includes(p.status)&&!p.approved_hash&&/\b[-\w.]+\/[-\w.]+\b/.test(text)){
            const selected=await repository(undefined,text);
            if(selected){if(!tracked)throw Error('Durable tracking is required for repository selection');const simple=/^(?:please )?(?:(?:use|connect|target)(?: the)?(?: repository| repo)? )?([-\w.]+\/[-\w.]+)[.!\s]*$/i.exec(text);const n=await mutate('answer',{p_repository:selected,p_text:simple?.[1]??text});return reply(n,'I saved the connected target repository and will prepare the current scope for approval.');}
        }
        // The pending question is persisted in detail and published atomically.
        // Bind short choices only to that exact most-recent prompt; an interrupted
        // conversation needs an explicit project-answer prefix or project reference.
        const explicitAnswer=/^(?:answer (?:for|to) (?:the |this )?project|project answer)\s*:\s*(.+)$/is.exec(text);
        const choice=text.replace(/[.!]+$/,'').trim().replace(/^(?:use|choose|select|I (?:prefer|choose|want))(?: the)?\s+/i,'').replace(/^the\s+/i,'');
        const shortChoice=choice.length<=100&&(/^(?:\d{1,4}(?: version| edition)?|locally|local|online|offline|both|either|yes|no|original(?: one| version| edition)?)$/i.test(choice)||choice.length>0&&choice.split(/\s+/).every(w=>w.length>2&&p.detail?.toLowerCase().includes(w.toLowerCase())));
        const pendingQuestion=p.status==='awaiting_input'&&!p.approved_hash&&!!p.detail;
        const directlyBound=pendingQuestion&&latestAssistant?.content===projectMessage(p.id,p.status,p.detail!)&&shortChoice;
        if(pendingQuestion&&(explicitAnswer||directlyBound)){
            if(!tracked)throw Error('Durable tracking is required for a project answer');
            const n=await mutate('answer',{p_text:explicitAnswer?.[1]??text});return reply(n,'I saved your answer to the project question and will continue planning with that decision.');
        }
        // A different non-software outcome must not amend a saved coding
        // scope merely because its wording overlaps the old objective.
        if (start && input.softwareBuildIntent !== true) return null;
        const topicWords=new Set((p.objective+' '+p.clarifications+' '+(p.spec?.requirements.join(' ')??'')).toLowerCase().match(/[a-z]{5,}/g)??[]);for(const common of ['build','browser','project','create','application','working','original','return','result','preview','complete','required','should','would','could','please','there','their','which','about','after','before'])topicWords.delete(common);
        const related=(text.toLowerCase().match(/[a-z]{5,}/g)??[]).some(w=>topicWords.has(w));
        const projectReference=related||/\b(?:the|this|my) (?:game|app|website|project)\b|\b(?:edition|requirement|keyboard|multiplayer|undo|button|controls?|localStorage|reload|persistence|interface|screen|layout|component|accessibility|opponent|rules?|turns?|pieces?|dark mode)\b|^(?:please )?(?:make|change|update|keep|retain|preserve|fix) (?:it|this|that)\b/i.test(actionText(text));
        if (projectReference && (amendmentIntent(text) || /^(?:what|how) about\b/i.test(text) || !/^\s*(?:what|why|how|can|would|could|is|are)\b/i.test(text))) {
            if(!tracked)throw Error('Durable tracking is required for a project clarification');
            const n=await mutate('amend',{p_text:text});return reply(n,n.detail!);
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
    // Lexical matches identify candidates only. Ambiguous nouns such as
    // "application" or "program" are not authorization to launch coding.
    // Existing saved-project controls above retain their scoped behavior.
    if (input.softwareBuildIntent !== true) return null;
    if (!tracked)
        throw Error('Durable chat request tracking is required before launching background projects');
    let objective = text;
    if (follow) {
        const brief=referencedProjectBrief(history);
        if(!brief)return 'Which software project should I build? Describe or identify the original brief; multiple requests or missing requirements make “that” ambiguous. No background project was started.';
        objective=brief;
    }
    if (objective.length > 8000)
        return 'Please narrow the project brief to 8,000 characters. I will not silently truncate its requirements.';
    const created = await projectRpc<Project>(gameProjectIntent(objective)?'create_game_work_project':'create_work_project', { p_id: projectId(requestId), p_request: requestId, p_actor: input.actorId, p_chat: input.chatId, p_objective: objective, p_repository: await repository(input.activeRepoId, text) });
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
