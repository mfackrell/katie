// Resource estimates are not spending authorizations. A specialist proposal
// has its own scope, assumptions, dependencies and uncertainty, and can be
// reconciled without silently double-counting overlapping work packages.
const positive=n=>Number.isSafeInteger(n)&&n>=0;
export function reconcileSpecialistEstimates(approvedScope, proposals) {
 if(!Array.isArray(proposals)||!proposals.length)throw Error('Missing specialist proposals');
 const expected=new Map(approvedScope.workPackages.map(p=>[p.id,p]));
 const claims=new Map(),accepted=[];
 for(const p of proposals){
  if(!p||typeof p.specialist!=='string'||!p.specialist.trim()||!Array.isArray(p.packages))throw Error('Invalid specialist proposal');
  for(const x of p.packages){
   if(!expected.has(x.packageId)||!positive(x.lowerTokens)||!positive(x.expectedTokens)||!positive(x.upperTokens)||
      x.lowerTokens>x.expectedTokens||x.expectedTokens>x.upperTokens||
      typeof x.basis!=='string'||!x.basis.trim()||!Array.isArray(x.dependencies))throw Error('Invalid scoped package estimate');
   const key=x.packageId;
   if(claims.has(key))throw Error('Overlapping specialist ownership: '+key);
   claims.set(key,p.specialist);
   accepted.push({...x,specialist:p.specialist});
  }
 }
 const missing=[...expected.keys()].filter(k=>!claims.has(k));
 if(missing.length)throw Error('Unestimated packages: '+missing.join(','));
 const totals=accepted.reduce((acc,p)=>({lowerTokens:acc.lowerTokens+p.lowerTokens,
  expectedTokens:acc.expectedTokens+p.expectedTokens,upperTokens:acc.upperTokens+p.upperTokens}),
  {lowerTokens:0,expectedTokens:0,upperTokens:0});
 const overlapDependencies=accepted.flatMap(x=>x.dependencies
  .filter(d=>!expected.has(d)).map(d=>({packageId:x.packageId,unknownDependency:d})));
 if(overlapDependencies.length)throw Error('Unknown work-package dependencies');
 return {version:1,kind:'reconciled_specialist_resource_forecast',
  assignments:accepted,totals,spendingAuthorization:'unchanged',
  scopeBaselineTokens:approvedScope.totals.expectedTokens,
  varianceTokens:totals.expectedTokens-approvedScope.totals.expectedTokens,
  reconciliation:'One designated specialist owns each work package; dependencies do not become duplicate allocations.',
  independentlySubmitted:proposals.every(p=>p.origin==='specialist_verified')};
}
// Until specialist actors produce signed scoped estimates, designate work
// ownership explicitly; never represent these baseline proposals as independent.
export function provisionalSpecialistPlan(forecast) {
 const owners={requirements_architecture:'architecture',backend_data:'backend',
 frontend_integration:'frontend',testing_debugging:'quality_assurance',
 independent_review_revision:'independent_review',deployment_acceptance:'deployment'};
 return reconcileSpecialistEstimates(forecast,forecast.workPackages.map(p=>({
  specialist:owners[p.id]??'development',origin:'executive_baseline',
  packages:[{packageId:p.id,lowerTokens:p.lowerTokens,expectedTokens:p.estimatedTokens,
   upperTokens:p.upperTokens,basis:p.estimateBasis,
   dependencies:(p.id==='deployment_acceptance'?['testing_debugging','independent_review_revision']:
    p.id==='testing_debugging'?['frontend_integration','backend_data']:[])
    .filter(id=>forecast.workPackages.some(entry=>entry.id===id))}]
 })));
}
