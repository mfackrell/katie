export interface CoverageRepair {
 missingRuleIds:string[];
 requiredCoverage:Array<{ruleId:string;category:string;status:string;description:string;sourceIds:string[];action:string}>;
 blockingUnknowns:Array<{id:string;question:string;ruleIds:string[]}>;
 existingScenarioIds:string[];
 mayAutoApprove:false;
 instructions:string;
}
export function gameCoverageRepair(plan:unknown):CoverageRepair|null;
