import { z } from 'zod';
import type { ManagedAgent } from '@/lib/agents/policy';
export type Mission = { project_id?:string|null;project_kind?:string|null;project_evidence?:unknown; id:string;objective:string;team:ManagedAgent[];status:string;max_calls:number;calls:number;token_allowance:number;reserved_tokens:number;actual_tokens:number;max_minutes:number;deadline:string|null;result:string|null;detail:string|null;repository_id:string|null };
export type Assignment = {id:string;mission_id:string;job_key:string;role:'plan'|'work'|'compose'|'review'|'revise'|'development';agent_id:string;instruction:string;dependencies:string[];payload:Record<string,unknown>;status:string;attempts:number;lease:string;lease_until:string;result:Record<string,unknown>|null;detail:string|null};
export type Claim = {mission:Mission;job:Assignment};
export const planSchema = z.object({assignments:z.array(z.object({key:z.string().regex(/^[a-z][a-z0-9_]{0,24}$/),agentId:z.string().uuid(),instruction:z.string().min(1).max(5000),capability:z.enum(['analysis','research','writing','development']),dependencies:z.array(z.string()).max(2)}).strict()).min(1).max(3),deliverable:z.string().min(1).max(2000)}).strict();
export const reviewSchema=z.object({verdict:z.enum(['pass','changes_requested','blocked']),findings:z.array(z.string().min(1).max(2000)).max(8),summary:z.string().min(1).max(3000)}).strict();
export function parseJSON(text:string):unknown {return JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));}
export function validatePlan(value:unknown,mission:Mission){
 const plan=planSchema.parse(value),seen=new Set<string>();
 for(const a of plan.assignments){
  if(['plan','compose','review','revision','review_again'].includes(a.key)||seen.has(a.key))throw Error('Reserved or duplicate assignment key');
  if(a.dependencies.some(d=>!seen.has(d)))throw Error('Dependencies must reference earlier assignments in this mission');
  const agent=mission.team.find(x=>x.id===a.agentId);
  if(!agent)throw Error('Planner selected an agent outside the saved team');
  if(a.capability==='research'&&!agent.config.research)throw Error('Research permission denied');
  if(a.capability==='development'&&(!agent.config.development||!mission.repository_id))throw Error('Approved development connection required');
  seen.add(a.key);
 }
 return plan;
}
export function calculate(raw:unknown){
 const input=z.object({operation:z.enum(['add','subtract','multiply','divide','power']),values:z.array(z.number().finite()).min(2).max(12)}).strict().parse(raw);
 const [first,...rest]=input.values;
 const result=rest.reduce((a,b)=>{if(input.operation==='add')return a+b;if(input.operation==='subtract')return a-b;if(input.operation==='multiply')return a*b;if(input.operation==='divide'){if(b===0)throw Error('Division by zero');return a/b;}return a**b;},first);
 if(!Number.isFinite(result))throw Error('Nonfinite calculation');
 return {operation:input.operation,inputs:input.values,result};
}
