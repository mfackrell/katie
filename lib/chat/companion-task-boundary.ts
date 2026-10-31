import {
  classifyUserTurn, emptyTaskProgress, isProjectBrief,
  type ProjectSnapshot, type ProjectTransition, type TaskProgressState,
} from './task-progress';

/** Companion is a presentation mode, never an authorization/actor-kind grant.
 * Keep its identification narrow until Katie has a dedicated persisted
 * companion actor_kind; do not infer companion mode from chat content. */
export function isCompanionActorIdentity(identity:{
  name?:string|null; systemPrompt?:string|null;
}):boolean {
  return /^adult katie$/i.test(identity.name?.trim()??'') ||
    /^\s*(?:KATIE\s*[—-]\s*)?Adult Companion System Prompt\b/im.test(identity.systemPrompt??'');
}

/** Only sourced, explicit work is a managed project. A casual greeting or
 * personal description must not become a permanent project identity. */
export function isExplicitCompanionProjectSource(text:string):boolean {
  const source=text.trim();
  if(isProjectBrief(source))return true;
  if(/^(?:start|open|resume|return to|switch to|work on)\s+(?:(?:a|the|my|our|this|that|saved|earlier|new)\s+){0,3}(?:project|engagement|application|website|software project)\b/i.test(source))return true;
  return /^(?:please\s+)?(?:build|implement|develop|design|prepare|draft|create)\b/i.test(source) &&
    /\b(?:dashboard|application|business plan|forecast|budget|report|website|software|code|proposal|financial model|project)\b/i.test(source);
}

/** Never let a synthetic legacy project ("Good. What's up?") or its old
 * objective influence companion attachment selection, routing, or prompts.
 * Preserve authentic project snapshots for an explicit future resume. */
export function scopeCompanionTaskProgress(previous:TaskProgressState):TaskProgressState {
  const projects=(previous.projects??[]).filter((entry:ProjectSnapshot)=>
    isExplicitCompanionProjectSource(entry.projectContext.text));
  const active=previous.projectContext &&
    isExplicitCompanionProjectSource(previous.projectContext.text)
    ? projects.find(entry=>entry.projectContext.userMessageId===previous.projectContext?.userMessageId)
    : undefined;
  if(active)return {...previous,projects};
  return {...emptyTaskProgress(),
    ...(projects.length?{projects}:{}),
    lastUserMessageId:previous.lastUserMessageId,
    lastAssistantMessageId:previous.lastAssistantMessageId,
    ...(previous.lastUserSource?{lastUserSource:previous.lastUserSource}:{}),
    lastUserIntent:'conversation'};
}

export function shouldTrackCompanionProject(input:{
  message:string; previous:TaskProgressState;
  explicitProjectIntent?:boolean;
  projectTransition?:ProjectTransition;
}):boolean {
  if(input.explicitProjectIntent || input.projectTransition || isExplicitCompanionProjectSource(input.message))return true;
  if(!input.previous.projectContext || !isExplicitCompanionProjectSource(input.previous.projectContext.text))return false;
  const current=input.message.trim();
  // An image-only turn or an ordinary companion exchange is not permission
  // to resume an older work item or turn conversational questions into tasks.
  if(!current || /^\[image\]$/i.test(current) ||
    /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|how are you|what(?:'s| is) up)\b/i.test(current))
    return false;
  if(/\b(?:that|the|my|our|this|saved)\s+(?:project|application|report|dashboard|website|proposal|forecast|draft)\b/i.test(current) ||
    /^(?:please\s+)?(?:continue|resume|revise|rewrite|edit|finish|implement|build|draft|prepare)\b/i.test(current))
    return true;
  // An answer to a genuine project's pending question remains project work,
  // but the absence of such a project never gives a social question authority.
  return input.previous.pending.length>0 && classifyUserTurn(current)!=='conversation';
}

/** Companion dialogue uses STM/history for continuity, not the managed
 * task ledger. Save a cursor without retaining fictional pending questions. */
export function recordCompanionConversationTurn(
  previous:TaskProgressState,input:{messageId:string;text:string}
):TaskProgressState {
  const cleared=scopeCompanionTaskProgress(previous);
  return {...emptyTaskProgress(),
    ...(cleared.projects?.length?{projects:cleared.projects}:{}),
    lastUserMessageId:input.messageId,
    lastAssistantMessageId:cleared.lastAssistantMessageId,
    lastUserSource:{userMessageId:input.messageId,text:input.text},
    lastUserIntent:'conversation'};
}

export function finishCompanionConversationTurn(
  previous:TaskProgressState,assistantMessageId:string
):TaskProgressState {
  return {...previous,projectContext:null,objective:null,
    pending:[],answered:[],projectClarification:undefined,
    workProduct:undefined,stage:'working',nextAction:'continue_original_goal',
    lastAssistantMessageId:assistantMessageId};
}
