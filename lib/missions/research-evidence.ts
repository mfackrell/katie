// Review receipts remain complete in storage. Models need substantive findings,
// not the previous reviewer's draft-blind assessment or duplicate passing checks.
export function researchRecoveryEvidence(value:unknown,includeCandidate:boolean):unknown{
 if(!value||typeof value!=='object'||Array.isArray(value))return value;
 const evidence=value as Record<string,unknown>,recovery=evidence.researchRecovery;
 if(!recovery||typeof recovery!=='object'||Array.isArray(recovery))return value;
 const r=recovery as Record<string,unknown>,raw=r.independentFindings;
 const review=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
 return {...evidence,researchRecovery:{sourceMissionId:r.sourceMissionId,...(includeCandidate?{lastCandidate:r.lastCandidate}:{}),independentFindings:{verdict:review.verdict,findings:review.findings,clarification:review.clarification,checks:Array.isArray(review.checks)?review.checks.filter(c=>c&&typeof c==='object'&&(c as Record<string,unknown>).passed===false):[]}}};
}
