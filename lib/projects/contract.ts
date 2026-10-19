import { createHash } from 'node:crypto';
import { z } from 'zod';
import {validateGameAssessmentCapacity} from './game-evidence';
import {validateProjectGame,type ProjectGame} from '../../scripts/project-game-rules.mjs';
const path = z.string().min(1).max(300).refine(s => s.startsWith('/') && !s.startsWith('//') && !/[\\\s#%]/.test(s) && !s.split('/').some(p => p === '.' || p === '..'), 'Internal application route required');
const step = z.discriminatedUnion('action', [
    z.object({ action: z.literal('goto'), path }).strict(), z.object({ action: z.literal('click'), selector: z.string().min(1).max(500) }).strict(), z.object({ action: z.literal('fill'), selector: z.string().min(1).max(500), value: z.string().min(1).max(2000) }).strict(), z.object({ action: z.literal('expectVisible'), selector: z.string().min(1).max(500) }).strict(), z.object({ action: z.literal('expectText'), selector: z.string().min(1).max(500), value: z.string().min(1).max(2000) }).strict(),
]);
export const browserContract = z.object({ path, scenarios: z.array(z.object({ name: z.string().min(1).max(200), steps: z.array(step).min(1).max(100) }).strict()).min(1).max(20) }).strict();
export const projectPlanSchema = z.object({ name: z.string().min(1).max(120), summary: z.string().min(1).max(1800), requirements: z.array(z.string().min(1).max(500)).min(1).max(30), allowedPaths: z.array(z.string().min(1).max(200)).min(1).max(12), milestones: z.array(z.object({ title: z.string().min(1).max(120), instruction: z.string().min(1).max(3500), contract: browserContract }).strict()).min(1).max(6), finalContract: browserContract, game: z.custom<ProjectGame>().optional() }).strict();
export type ProjectPlan = z.infer<typeof projectPlanSchema>;
export function canonical(value: unknown): string { if (Array.isArray(value))
    return '[' + value.map(canonical).join(',') + ']'; if (value && typeof value === 'object')
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}'; return JSON.stringify(value); }
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
// Lossless view of a validated game plan. Only canonically identical contracts are
// referenced; the complete expanded specification remains stored and hashed.
export function gameSpecificationView(p:ProjectPlan){
 if(!p.game)return p;
 return {...p,milestones:p.milestones.map(({contract,...m})=>digest(contract)===digest(p.finalContract)?{...m,contractRef:'finalContract'}:{...m,contract}),
  game:{...p.game,acceptance:{...p.game.acceptance,scenarios:p.game.acceptance.scenarios.map((s:Record<string,unknown>)=>{
   const final=p.finalContract.scenarios.find(b=>b.name===s.id);
   if(s.kind==='browser'&&final&&digest(final.steps)===digest(s.steps)){const metadata={...s};delete metadata.steps;return{...metadata,stepsRef:`finalContract.scenarios[name=${String(s.id)}].steps`};}
   return s;
  })}}};
}
export function validateProjectPlan(raw: unknown) { const p = projectPlanSchema.parse(raw); if (!p.game && canonical(p).length > 20000)
    throw Error('Specification exceeds the bounded approval/evidence package; simplify the milestones without dropping requirements'); for (const prefix of p.allowedPaths)
    if (!/^(?:app|apps|components|lib|public|tests|docs)\/[a-zA-Z0-9_./[\]-]+\/?$/.test(prefix) || prefix.split('/').some(s => s === '.' || s === '..') || /\.env|\.github|node_modules/.test(prefix))
        throw Error('Scope requires isolated application/source/test paths; dependencies, secrets and deployment configuration need a separate decision'); for (const c of [...p.milestones.map(m => m.contract), p.finalContract]) {
    if (new Set(c.scenarios.map(s => s.name)).size !== c.scenarios.length || c.scenarios.flatMap(s => s.steps).length > 100)
        throw Error('Invalid scenario count');
    for (const s of c.scenarios)
        if (!s.steps.some(s => s.action === 'expectText' || s.action === 'expectVisible') || s.steps.some(s => s.action.startsWith('expect') && 'selector' in s && /^(?:\*|html|body|:root)$/i.test(s.selector)))
            throw Error('Scenarios require actual application assertions');
} if (digest(p.milestones.at(-1)!.contract) !== digest(p.finalContract))
    throw Error('Final milestone must execute the entire final acceptance contract'); if(p.game){validateProjectGame(p.game,p.allowedPaths,p.finalContract);validateGameAssessmentCapacity(p);if(canonical(gameSpecificationView(p)).length>20000)throw Error('Specification exceeds the bounded approval/evidence package; simplify unique content without dropping requirements');} return p; }
export function projectMessage(id: string, status: string, text: string) { return `<!-- katie-project-status:${id}:${status} -->\n\n${text}`; }
export function projectId(request: string) { const h = createHash('sha256').update('katie-project:' + request).digest('hex'); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32); }
