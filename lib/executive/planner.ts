import {z} from 'zod';
import {orchestrationChoices,orchestrationFailure} from '@/lib/orchestration/routing';
import {boundedProvider} from '@/lib/orchestration/bounded-provider';

const slug=z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
export const executivePlanSchema=z.object({
 assignments:z.array(z.object({
  slug, objective:z.string().trim().min(15).max(3500),
  requiresRepository:z.boolean()
 }).strict()).max(5),
 provision:z.array(z.object({
  domain:slug,capability:slug,
  objective:z.string().trim().min(15).max(3500)
 }).strict()).max(3),
 unavailable:z.array(z.object({
  capability:slug,reason:z.string().trim().min(12).max(1000)
 }).strict()).max(5)
}).strict().superRefine((plan,ctx)=>{
 if(!plan.assignments.length&&!plan.provision.length&&!plan.unavailable.length)
  ctx.addIssue({code:'custom',message:'Executive plan must include at least one workstream or blocker'});
 const unique=new Set<string>();
 for(const work of plan.assignments){
  const key=work.slug+'\n'+work.objective.toLowerCase();
  if(unique.has(key))ctx.addIssue({code:'custom',message:'Duplicate assignment'});
  unique.add(key);
 }
});
export type ExecutivePlan=z.infer<typeof executivePlanSchema>;
type Specialist={slug:string;title:string;description:string;capabilities:string[]};
export async function planExecutiveAssignment(input:{
 objective:string;specialists:Specialist[];requestId:string;
}):Promise<ExecutivePlan>{
 const choices=await orchestrationChoices({objective:input.objective,instruction:'Create a management-only delegation plan against verified specialist contracts.',requestId:input.requestId,planning:true});
 const system=[
  'You are the management-only Executive Orchestrator PLAN ENGINE.',
  'You may ONLY select, scope and delegate autonomous work; NEVER perform any underlying research, financial analysis, QA or coding.',
  'Return ONLY strict JSON with keys assignments, provision, unavailable. No Markdown.',
  'Active verified specialists (ONLY these slugs can appear in assignments):',
  JSON.stringify(input.specialists),
  'Factory-provisionable capability contracts: financial_analysis, operations_analysis, research_synthesis.',
  'If a needed capability is absent but matches one of those contracts, add a provision item with a short domain slug and that exact capability.',
  'If a needed capability requires tools or permissions not proven by these contracts, list it in unavailable; NEVER invent tool access.',
  'Create 2-5 distinct substantive workstreams for multidomain projects if qualified specialists exist; use one for a focused task.',
  'Each assignment must have a concrete outcome and acceptance criteria in objective, preserving the original user scope.',
  'For repository inspection, set requiresRepository=true even for READ-ONLY review; do not imply GitHub access without a verified connected repository.',
  'Do not interpret authorization to audit as approval to change or deploy production.',
  'Do not produce the requested deliverable yourself.',
  'Do not say work is complete or independently reviewed before evidence exists.',
  'Schema: {"assignments":[{"slug":"registered_slug","objective":"task with criteria","requiresRepository":true|false}],"provision":[{"domain":"short_name","capability":"one_verified_factory_capability","objective":"task with criteria"}],"unavailable":[{"capability":"snake_case","reason":"specific limitation"}]}'
 ].join('\n');
 let last='Executive planning unavailable';
 for(const choice of choices){
  try{
   const response=await boundedProvider(choice).responses.create({model:choice.modelId,instructions:system,
    input:[{role:'user',content:'Delegate this business objective. Do not answer it:\n'+input.objective}],max_output_tokens:4000,store:false
   },{timeout:90_000});
   if(response.status!=='completed')throw Error('Executive planning output incomplete');
   const parsed=executivePlanSchema.parse(JSON.parse(response.output_text?.trim()??''));
   const registered=new Set(input.specialists.map(s=>s.slug));
   const supported=new Set(['financial_analysis','operations_analysis','research_synthesis']);
   if(parsed.assignments.some(a=>!registered.has(a.slug)))throw Error('Plan selected unregistered specialist');
   if(parsed.provision.some(p=>!supported.has(p.capability)))throw Error('Plan requested unsupported factory capability');
   if(parsed.assignments.length+parsed.provision.length>6)throw Error('Too many workstreams');
   return parsed;
  }catch(error){
   await orchestrationFailure(choice,error);
   last=error instanceof Error?error.message:'Unknown model failure';
   console.warn('[Executive] Planner candidate rejected',{provider:choice.provider.name,model:choice.modelId,reason:last.slice(0,180)});
  }
 }
 throw Error('Executive planning could not produce a verified delegation plan: '+last.slice(0,150));
}
