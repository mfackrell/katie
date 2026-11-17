/** The browser may resume an original paused request only after the server has
 * verified its already-paid routing checkpoint. Polling never creates an LLM
 * request, changes the immutable original input, or grants spending approval.
 * A bounded wait leaves unresolved work saved rather than retransmitting it. */
export type LateRoutingStatus = {
  status?: string;
  workflowStatus?: string|null;
  routingRecoveryReady?: boolean;
};

export async function recoverLateRoutingResponse(args: {
  readStatus: () => Promise<LateRoutingStatus|null>;
  resumeOriginal: () => Promise<Response>;
  wait: () => Promise<void>;
  cancelled: () => boolean;
  maxChecks?: number;
}): Promise<Response|null> {
  const maxChecks=Math.max(1,Math.min(40,args.maxChecks??30));
  for(let check=0;check<maxChecks;check++) {
    if(args.cancelled()) return null;
    const state=await args.readStatus();
    if(!state || state.workflowStatus!=='paused') return null;
    if(state.routingRecoveryReady===true) {
      if(args.cancelled()) return null;
      return args.resumeOriginal();
    }
    if(check+1<maxChecks) await args.wait();
  }
  return null;
}
