// Game planning carries both the complete original brief and completed reviewed
// research. Approved game execution/assessment also carries full original sources. Model dispatch
// separately counts and reserves real tokens within unchanged spending limits.
export function projectEvidenceLimit(profile:string|undefined,phase:string){
 return profile==='game'?(phase==='specification'?60000:['development','assessment'].includes(phase)?96000:30000):30000;
}
