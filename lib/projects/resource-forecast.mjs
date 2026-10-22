// Scope-based *forecast*, never spending authorization. Unit-effort assumptions
// are explicit and intentionally recalibratable against completed projects.
const has=(s,re)=>re.test(s);
export function estimateProjectResources(spec,objective=''){
 const text=[objective,spec.summary,...spec.requirements,...spec.milestones.map(m=>m.instruction)].join(' ').toLowerCase();
 const n=spec.milestones.length,requirements=spec.requirements.length;
 const scenarios=spec.finalContract.scenarios.length;
 const steps=spec.finalContract.scenarios.reduce((sum,s)=>sum+s.steps.length,0);
 const paths=spec.allowedPaths.length,rules=spec.game?.rules?.length??0;
 const backend=has(text,/database|postgres|supabase|migration|api|authentication|server|backend|payment|storage|persist/);
 const integration=has(text,/integration|provider|external|webhook|third.party|oauth|payment|sync/);
 const frontend=has(text,/frontend|ui|interface|browser|page|component|responsive|dashboard|game|visual/);
 const uncertainty=has(text,/unknown|undecided|unclear|research|explore|investigat|legacy|migration/);
 const components=[
  {id:'requirements_architecture',label:'Requirements and architecture',units:requirements+Math.max(1,Math.ceil(paths/2)),unitTokens:1300,reason:'Requirement count and affected source areas'},
  {id:'backend_data',label:'Database and backend',units:(backend?3:0)+Math.ceil(paths/3)+(integration?2:0),unitTokens:5200,reason:'Backend, data and external-system scope'},
  {id:'frontend_integration',label:'Frontend and integration',units:(frontend?3:0)+n+(integration?2:0),unitTokens:4200,reason:'User-facing milestones and integrations'},
  {id:'testing_debugging',label:'Testing and debugging',units:n*2+scenarios+Math.ceil(steps/8)+Math.ceil(rules/4),unitTokens:2800,reason:'Milestones, acceptance scenarios, steps and game-rule coverage'},
  {id:'independent_review_revision',label:'Independent review and revisions',units:n+Math.ceil(requirements/5)+Math.ceil(scenarios/4),unitTokens:3800,reason:'Distinct independently reviewed outputs and revisions'},
  {id:'deployment_acceptance',label:'Deployment and acceptance',units:2+n+Math.ceil(scenarios/6),unitTokens:2500,reason:'Milestone previews and final whole-project acceptance'}
 ];
 const workPackages=components.filter(x=>x.units>0).map(x=>{
  const expectedTokens=x.units*x.unitTokens;
  return {id:x.id,label:x.label,estimatedTokens:expectedTokens,
   lowerTokens:Math.ceil(expectedTokens*0.65),upperTokens:Math.ceil(expectedTokens*(uncertainty?2.2:1.75)),
   estimateBasis:`${x.reason}; ${x.units} complexity units × ${x.unitTokens} assumed tokens/unit`};
 });
 const sum=key=>workPackages.reduce((total,p)=>total+p[key],0);
 return {
  version:1,kind:'resource_forecast_not_authorization',
  inputs:{milestones:n,requirements,scenarios,acceptanceSteps:steps,allowedPaths:paths,gameRules:rules,backend,integration,frontend,uncertainty},
  workPackages,
  totals:{lowerTokens:sum('lowerTokens'),expectedTokens:sum('estimatedTokens'),upperTokens:sum('upperTokens')},
  estimatedApiCostUsd:null,estimatedToolCostUsd:null,estimatedInfrastructureCostUsd:null,
  estimatedElapsedHours:null,
  costBasis:'Unavailable until routed model mix, provider prices, tool rates, environment costs and parallelism are known. Do not treat tokens as dollars.',
  timeBasis:'Elapsed time requires model latency, worker capacity, test duration and dependency assumptions; no fabricated schedule.',
  rationale:'Bottom-up work-package forecast based on reviewed scope. Effort-unit rates are heuristic assumptions, not calibrated historical actuals. The upper bound is wider for unresolved scope. Reforecast after each completed milestone.',
  spendingAuthorization:'unchanged'
 };
}
