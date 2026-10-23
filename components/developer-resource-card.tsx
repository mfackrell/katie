'use client';
export type RecoveryProposal={state:'estimated';scopeHash:string;used:number;authorized:number;expectedAdditional:number;upperAdditional:number;proposedCeiling:number;proposedMaxMissions:number;needsAuthorization:boolean;forecast:{rationale:string;totals:{lowerTokens:number;expectedTokens:number;upperTokens:number}}}|{state:'needs_specialist_estimate';reason:string;used:number;authorized:number};
export function DeveloperResourceCard({proposal,pending,error,onApprove}:{
 proposal:RecoveryProposal;pending:boolean;error:string|null;
 onApprove:(hash:string,ceiling:number,hours:48|72)=>void;
}){
 if(proposal.state!=='estimated')return <section aria-label="Developer resource assessment" className="rounded-xl border border-amber-700/40 p-4 text-sm"><strong>Developer Orchestrator needs additional specification assessment</strong><p>{proposal.reason}</p></section>;
 if(!proposal.needsAuthorization)return null;
 return <section aria-label="Developer resource approval" className="rounded-xl border p-4 text-sm space-y-2">
 <h3 className="font-semibold">Katie needs approval to recover this project</h3>
 <p>Previously accounted: {proposal.used.toLocaleString()} tokens. Current authorization: {proposal.authorized.toLocaleString()} tokens.</p>
 <p>Estimated additional work: {proposal.expectedAdditional.toLocaleString()} tokens; conservative upper estimate: {proposal.upperAdditional.toLocaleString()} tokens.</p>
 <p>Proposed **total** spending ceiling: <strong>{proposal.proposedCeiling.toLocaleString()} tokens</strong>. This is an estimate, not a charge.</p>
 <p>Proposed mission limit: {proposal.proposedMaxMissions}. The saved work and historical charges will remain unchanged.</p>
 <p className="text-xs opacity-70">Independent specification review and coding approval are still required.</p>
 {error?<p role="alert">{error}</p>:null}
 <div className="flex gap-2 flex-wrap">
 <button type="button" disabled={pending} className="rounded-md border px-3 py-2" onClick={()=>onApprove(proposal.scopeHash,proposal.proposedCeiling,48)}>Authorize and renew 48 hours</button>
 <button type="button" disabled={pending} className="rounded-md border px-3 py-2" onClick={()=>onApprove(proposal.scopeHash,proposal.proposedCeiling,72)}>Authorize and renew 72 hours</button>
 </div>
 </section>;
}
