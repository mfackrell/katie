// A diagnostic and conservative repair contract. Never manufacture an assertion,
// game move, or user decision merely to satisfy coverage counts.
export function gameCoverageRepair(plan) {
 const game=plan?.game; if(!game?.rules?.rules||!game?.acceptance?.scenarios)return null;
 const scenarios=game.acceptance.scenarios;
 const covered=new Set(scenarios.flatMap(s=>Array.isArray(s.ruleIds)?s.ruleIds:[]));
 const missing=game.rules.rules.filter(r=>r.status!=='unresolved'&&!covered.has(r.id));
 const blocking=(game.rules.unknowns??[]).filter(u=>u.status==='open'&&u.blocking);
 const actions=missing.map(rule=>({
   ruleId:rule.id,category:rule.category,status:rule.status,
   description:rule.description,
   sourceIds:rule.sourceIds,
   action:'Add real model or browser steps demonstrating this rule and list its ID in that scenario. Preserve all currently valid scenarios. Do not simply add the ID to a scenario that does not test it.'
 }));
 return {missingRuleIds:missing.map(r=>r.id),requiredCoverage:actions,
   blockingUnknowns:blocking.map(u=>({id:u.id,question:u.question,ruleIds:u.ruleIds})),
   existingScenarioIds:scenarios.map(s=>s.id),
   mayAutoApprove:false,
   instructions:'The validator may establish which approved rules lack declared coverage, but cannot establish that an existing test actually exercises a rule. Only add coverage with corresponding concrete deterministic expected states or observable browser assertions. Never forge scenario references, change rules to bypass coverage, invent decisions, or drop previously valid acceptance. Revalidate full expanded specification and require independent review of its exact final content.'};
}
