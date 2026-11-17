/** The durable workflow wins over an old chat_requests 'processing' receipt.
 * A queued, accepted RunPod job remains recoverable and is never described as
 * owner-paused. No state is changed or provider attempt retried by this helper.
 */
export function classifyPausedChatWorkflow(
  requestStatus: string,
  workflow: { status: string; error?: string | null } | null,
): { status: 'paused'; error: string; waitingForRunpod: false } |
   { status: 'processing'; waitingForRunpod: true } | null {
  if (requestStatus !== 'processing' || workflow?.status !== 'paused') return null;
  if (workflow.error?.includes('standalone_runpod_in_progress'))
    return { status: 'processing', waitingForRunpod: true };
  return {
    status: 'paused',
    waitingForRunpod: false,
    error: 'Saved request paused for accounting review. Open Status / Usage, then Active / unresolved work to choose whether to accept retained exposure and continue. Do not resend this request.',
  };
}


/** A routing timeout is a resumable, billed-provider boundary only when its
 * original owner-bound workflow is paused on that exact control-plane stage.
 * This predicate never authorizes a new model call. */
export function isPausedRoutingTimeout(workflow: {status:string;error?:string|null}|null): boolean {
  return workflow?.status==='paused'
    && Boolean(workflow.error?.includes('standalone_outcome_unknown')
      && workflow.error.includes('routing-rerank:'));
}

/** Only complete, settled, checkpointed attempts may authorize a saved replay.
 * Never equate a provider dispatch, reservation, or uncertain outcome to success. */
export function isSavedRoutingAttemptReady(attempt:{
  state:string;
  response_checkpoint?:{status:number;body:string}|null;
  actual_microusd?:string|null;
  cancelled_by_owner_at?:string|null;
}|null):boolean {
  return Boolean(attempt?.state==='settled'
    && attempt.actual_microusd!==null
    && attempt.actual_microusd!==undefined
    && attempt.response_checkpoint
    && attempt.response_checkpoint.body
    && attempt.response_checkpoint.status >= 200
    && attempt.response_checkpoint.status < 300
    && !attempt.cancelled_by_owner_at);
}


/** Check every consecutive saved routing helper (including correction passes)
 * with exact owner/actor/chat/request identity. Unfinished or unknown ordinals
 * fail closed; this function never dispatches or approves provider calls. */
export async function verifiedLateRoutingRecoveryReady(
  identity: {ownerId:string;actorId:string;chatId:string;requestId:string},
  lookup: (ordinal:number)=>Promise<{
    owner_id:string;actor_id:string;chat_id:string;request_id:string;
    state:string;response_checkpoint?:{status:number;body:string}|null;
    actual_microusd?:string|null;cancelled_by_owner_at?:string|null;
  }|null>,
):Promise<boolean> {
  let settledCount=0;
  for(let ordinal=0;ordinal<=8;ordinal++){
    const attempt=await lookup(ordinal);
    if(!attempt)return settledCount>0;
    if(ordinal===8 || attempt.owner_id!==identity.ownerId ||
        attempt.actor_id!==identity.actorId || attempt.chat_id!==identity.chatId ||
        attempt.request_id!==identity.requestId || !isSavedRoutingAttemptReady(attempt))
      return false;
    settledCount++;
  }
  return false;
}
