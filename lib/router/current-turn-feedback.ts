import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { getAccountingScope } from "@/lib/standalone-accounting/context";

/**
 * A-owned, read-only provenance contract for current user feedback.
 *
 * Never derive a target from the selected NEXT model. The producing model
 * must belong to a completed, saved, same-owner/actor/chat prior response.
 * This module makes no provider calls and mutates no production data.
 */
export type CurrentTurnFeedbackProvenanceV1 = Readonly<{
  version: "current-turn-feedback-v1";
  source: {
    requestId: string;
    userMessageId: string | null;
    textExcerpt: string;
    polarity: "positive" | "negative" | "ambiguous" | "none";
    dimension: "continuity" | "objective_fidelity" | "accuracy" | "user_satisfaction" | "unspecified";
    correctionExcerpt: string | null;
  };
  target:
    | { status: "attributed"; assistantMessageId: string; priorRequestId: string;
        provider: string; model: string; priorIntent: string | null;
        basis: "settled_scoped_saved_reply"; }
    | { status: "unattributed"; reason: "no_prior_completed_reply" |
        "missing_receipt" | "ambiguous_reference" | "scope_mismatch" | "not_feedback"; };
  /** Null means the objective relationship has not been source-established. */
  applicableToOngoingObjective: boolean | null;
}>;

type Polarity = CurrentTurnFeedbackProvenanceV1["source"]["polarity"];
type Dimension = CurrentTurnFeedbackProvenanceV1["source"]["dimension"];

/** Conservative, explicit assessment only; silence/continuation is never praise. */
export function classifyCurrentTurnFeedback(message: string): {
  polarity: Polarity; dimension: Dimension; correctionExcerpt: string | null;
} {
  const text = message.trim();
  const negative = /\b(?:that|this|your|you)\b[\s\S]{0,110}\b(?:terrible|awful|bad|wrong|horrible|poor|unhelpful|repetitive|repeated|repeating|missed|failed|mistake|incorrect|worse)\b|\b(?:not what i (?:asked|wanted|requested)|did(?:n't| not) (?:answer|understand|follow)|stop repeating)\b/i.test(text);
  const positive = /\b(?:that|this|your|you)\b[\s\S]{0,90}\b(?:great|excellent|perfect|helpful|fantastic|better|nailed|improved|correct|spot on|exactly right)\b|\b(?:exactly what i (?:asked|wanted)|well done|good job)\b/i.test(text);
  const polarity: Polarity = positive && negative ? "ambiguous" : negative ? "negative" : positive ? "positive" : "none";
  const dimension: Dimension = polarity === "none" ? "unspecified" :
    /\b(?:repeat|repetitive|same thing|continuity)\b/i.test(text) ? "continuity" :
    /\b(?:initiative|objective|missed|not what i|understand|follow)\b/i.test(text) ? "objective_fidelity" :
    /\b(?:incorrect|wrong|inaccurate|fact)\b/i.test(text) ? "accuracy" : "user_satisfaction";
  return {polarity,dimension,correctionExcerpt:polarity === "none" ? null : text.slice(0,600)};
}

function unattributed(
  source: CurrentTurnFeedbackProvenanceV1["source"],
  reason: Extract<CurrentTurnFeedbackProvenanceV1["target"],{status:"unattributed"}>["reason"],
  applicableToOngoingObjective: boolean | null,
): CurrentTurnFeedbackProvenanceV1 {
  return {version:"current-turn-feedback-v1",source,target:{status:"unattributed",reason},
    applicableToOngoingObjective};
}

const explicitTopicSwitch = /^(?:\s*)(?:new topic\s*:|change of subject\s*:|switching (?:topics|gears)\s*:)/i;

/**
 * The authenticated AsyncLocalStorage scope, NOT caller-supplied IDs, controls
 * all queries. The current request's original creation time bounds the search;
 * late/resumed requests cannot accidentally attribute feedback to newer turns.
 */
export async function deriveCurrentTurnFeedbackProvenance(input: {
  message: string; userMessageId?: string | null;
}): Promise<CurrentTurnFeedbackProvenanceV1 | null> {
  const scope=getAccountingScope();
  if (scope?.kind !== "standalone") return null;
  const {userId,actorId,chatId,requestId}=scope.context;
  const classified=classifyCurrentTurnFeedback(input.message);
  const source:CurrentTurnFeedbackProvenanceV1["source"]={
    requestId,userMessageId:input.userMessageId ?? null,
    textExcerpt:input.message.slice(0,600),
    ...classified,
  };
  const applicableToOngoingObjective=explicitTopicSwitch.test(input.message) ? false : null;
  if (classified.polarity === "none") return unattributed(source,"not_feedback",applicableToOngoingObjective);

  try {
    const db=getSupabaseAdminClient();
    const {data:currentRow,error:currentError}=await db.from("standalone_workflows")
      .select("created_at").eq("owner_id",userId).eq("actor_id",actorId)
      .eq("chat_id",chatId).eq("request_id",requestId).maybeSingle();
    const current=currentRow as {created_at?:string} | null;
    if (currentError || !current?.created_at)
      return unattributed(source,"missing_receipt",applicableToOngoingObjective);

    // Do not skip an intervening user or an incomplete/error assistant message:
    // the critic's target must be the immediate saved predecessor.
    const {data:previousRows,error:previousError}=await db.from("messages")
      .select("id,role").eq("actor_id",actorId).eq("chat_id",chatId)
      .lt("created_at",current.created_at).order("created_at",{ascending:false}).limit(1);
    if (previousError) return unattributed(source,"missing_receipt",applicableToOngoingObjective);
    const previous=previousRows as Array<{id:string;role:string}> | null;
    const last=previous?.[0];
    if (!last || last.role !== "assistant")
      return unattributed(source,"no_prior_completed_reply",applicableToOngoingObjective);

    const {data:priorRequestRow,error:requestError}=await db.from("chat_requests")
      .select("request_id,assistant_message_id").eq("actor_id",actorId).eq("chat_id",chatId)
      .eq("assistant_message_id",last.id).eq("status","completed").maybeSingle();
    const priorRequest=priorRequestRow as {request_id?:string;assistant_message_id?:string} | null;
    if (requestError || !priorRequest?.request_id || priorRequest.request_id === requestId)
      return unattributed(source,"missing_receipt",applicableToOngoingObjective);

    const {data:priorWorkflowRow,error:workflowError}=await db.from("standalone_workflows")
      .select("status,checkpoints").eq("owner_id",userId).eq("actor_id",actorId)
      .eq("chat_id",chatId).eq("request_id",priorRequest.request_id)
      .eq("status","completed").maybeSingle();
    const priorWorkflow=priorWorkflowRow as {checkpoints?:Record<string,unknown>|null;status?:string} | null;
    if (workflowError || !priorWorkflow)
      return unattributed(source,"scope_mismatch",applicableToOngoingObjective);
    const checkpoints=priorWorkflow.checkpoints as Record<string,unknown> | null;
    const audit=checkpoints?.["routing-delivery-audit:v1"];
    const attribution=audit && typeof audit==="object" ? audit as Record<string,unknown> : null;
    const provider=attribution?.provider,model=attribution?.model;
    if (typeof provider!=="string" || !provider.trim() ||
        typeof model!=="string" || !model.trim())
      return unattributed(source,"missing_receipt",applicableToOngoingObjective);
    return {
      version:"current-turn-feedback-v1",source,
      target:{status:"attributed",assistantMessageId:String(last.id),
        priorRequestId:priorRequest.request_id,provider,model,
        priorIntent:typeof attribution?.classifiedIntent==="string" ? attribution.classifiedIntent : null,
        basis:"settled_scoped_saved_reply"},
      applicableToOngoingObjective,
    };
  } catch {
    // Unavailable source records are unknown, never invented.
    return unattributed(source,"missing_receipt",applicableToOngoingObjective);
  }
}
