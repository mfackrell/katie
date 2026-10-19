import {z} from 'zod';

export const recoverySourceSchema=z.enum(['project','mission','task']);
export const recoveryCategorySchema=z.enum(['provider_transient','verification_infrastructure','implementation','configuration','permissions','budget','unknown']);
export type RecoveryCategory=z.infer<typeof recoveryCategorySchema>;
export type RecoverySource=z.infer<typeof recoverySourceSchema>;

export type RecoveryDiagnosis={
 category:RecoveryCategory;
 strategy:'retry_original'|'reverify_existing'|'scoped_repair'|'diagnose'|'owner_required';
 explanation:string;
 evidence:string;
 allowedPaths:string[];
};

// Trusted runtime errors are evidence, not instructions. Never use model output
// or arbitrary log text to grant a new permission or widen a repair scope.
const permission=/\b(unauthori[sz]ed|permission denied|credential|secret|token missing|owner approval|forbidden|401|403|RLS)\b/i;
const budget=/\b(budget|token allowance|allowance exhausted|deadline reached|maximum attempts|rate.*spend|payment required)\b/i;
const transient=/\b(429|rate limit|timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|502|503|504|provider unavailable)\b/i;
const browser=/chown ['"]?\/tmp\/fonts|chromium.*(?:launch|font|executable).*failed|browser bootstrap.*(?:error|failed)|Playwright.*browserType\.launch.*failed/i;
const install=/npm error (?:code ENOTCACHED|Exit handler never called)|baseline (?:npm|dependency).*failed|Vitest failed or did not produce a completion report|node_modules\/\.vite/i;
const testFailure=/\b(AssertionError|expect\w* failed|test failed|independent review rejected|missing requirement|changes_requested|TypeError|SyntaxError)\b/i;

const browserPaths=['scripts/project-browser-check.mjs','scripts/project-browser-engine.mjs','scripts/project-sandbox.mjs','tests/project-browser-check.test.mjs','tests/project-sandbox.test.mjs'];
const dependencyPaths=['scripts/project-ci.mjs','scripts/project-sandbox.mjs','tests/project-sandbox.test.mjs','tests/projects-runtime.test.mjs'];
export const allowedInfrastructurePaths=(kind:'browser'|'dependency'):string[]=>kind==='browser'?browserPaths:dependencyPaths;

export function validRepairPath(path:string):boolean{
 return typeof path==='string'&&path.length>3&&path.length<=200&&
   /^(?:app|apps|components|lib|scripts|tests|packages)\/[A-Za-z0-9_./[\]-]+\/?$/.test(path)&&
   !path.split('/').slice(0,-(path.endsWith('/')?1:0)||undefined).some(part=>!part||part==='.'||part==='..'||part==='node_modules'||part==='.git'||part==='.github'||part.startsWith('.env'))&&
   !(path.endsWith('/')&&path.split('/').filter(Boolean).length<2)&&
   !/(^|\/)(?:package(?:-lock)?\.json|vercel\.json|next\.config\.[a-z]+|\.npmrc|.*\.ya?ml)$/.test(path);
}
export function narrowPaths(paths:unknown):string[]{
 if(!Array.isArray(paths)||paths.length<1||paths.length>12||
    paths.some(path=>typeof path!=='string'||!validRepairPath(path)))throw Error('Repair paths are not explicitly authorized');
 return [...new Set(paths)];
}

export function diagnoseRecoveryFailure(input:{
 sourceType:RecoverySource;
 detail:string;
 trustedLog?:string;
 approvedProjectPaths?:string[]|null;
 taskKind?:string|null;
 previousVerification?:boolean;
}):RecoveryDiagnosis{
 const detail=(input.detail??'').slice(0,2000);
 const trusted=(input.trustedLog??'').slice(-12000);
 const total=detail+'\n'+trusted;
 // Secrets/authorization/budgets never trigger automated source changes.
 if(permission.test(detail))return {category:'permissions',strategy:'owner_required',explanation:'Credential or permission decision requires the owner.',evidence:detail,allowedPaths:[]};
 if(budget.test(detail))return {category:'budget',strategy:'owner_required',explanation:'Original spending, deadline or capacity limit reached.',evidence:detail,allowedPaths:[]};
 // Require a workflow log, not a freeform model guess, before considering a
 // shared-infrastructure source repair.
 if(trusted && (browser.test(trusted)||install.test(trusted))){
   const browserFailure=browser.test(trusted)&&!install.test(trusted);
   return {category:'verification_infrastructure',strategy:'scoped_repair',
     explanation:browserFailure?'Trusted browser runner could not initialize.':'Trusted verification dependencies or cache failed.',
     evidence:trusted.slice(-3500),allowedPaths:allowedInfrastructurePaths(browserFailure?'browser':'dependency')};
 }
 if(input.sourceType==='mission'&&transient.test(detail))
   return {category:'provider_transient',strategy:'retry_original',explanation:'Transient model or network failure may be retried within the original lease, attempts and budget.',evidence:detail,allowedPaths:[]};
 if(input.previousVerification&&input.sourceType==='project')
   return {category:'verification_infrastructure',strategy:'reverify_existing',
     explanation:'Use the original reviewed code and independent same-commit verification before any new coding.',evidence:detail,allowedPaths:[]};
 if(input.sourceType==='project'&&input.approvedProjectPaths&&testFailure.test(total)){
   try {return {category:'implementation',strategy:'scoped_repair',explanation:'Implementation or acceptance needs a targeted repair in the existing approved scope.',evidence:detail,allowedPaths:narrowPaths(input.approvedProjectPaths)};}
   catch{/* never infer safe paths from user content */}
 }
 if(permission.test(detail)||budget.test(detail))return {category:'configuration',strategy:'owner_required',explanation:'A protected configuration change needs the owner.',evidence:detail,allowedPaths:[]};
 return {category:'unknown',strategy:'diagnose',explanation:'No authenticated, actionable recovery cause yet. Preserve partial results and request an independent diagnosis.',evidence:detail,allowedPaths:[]};
}
