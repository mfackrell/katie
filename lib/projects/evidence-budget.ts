// Game planning carries both the complete original brief and completed reviewed
// research. Other phases retain their existing receipt bounds. Model dispatch
// separately counts and reserves real tokens within unchanged spending limits.
export function projectEvidenceLimit(profile:string|undefined,phase:string){
 return profile==='game'&&phase==='specification'?60000:30000;
}
