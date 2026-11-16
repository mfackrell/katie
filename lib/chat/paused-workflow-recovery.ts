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
