import {z} from 'zod';
export const capability=z.string().regex(/^[a-z][a-z0-9_-]{1,49}$/);
export const specialistContract=z.object({
 slug:capability,title:z.string().min(3).max(100),
 description:z.string().min(10).max(2000),
 capabilities:z.array(capability).min(1).max(20),
 adapter:z.enum(['mission','external']),
 endpointKey:capability.nullable(),
 version:z.number().int().positive(),
 status:z.enum(['registered','active','disabled','retired']),
 autonomy:z.enum(['supervised','delegated'])
}).strict().superRefine((s,c)=>{
 if(new Set(s.capabilities).size!==s.capabilities.length)c.addIssue({code:'custom',message:'Duplicate capability'});
 if(s.adapter==='mission'&&s.endpointKey!==null)c.addIssue({code:'custom',message:'Mission adapters cannot specify an external endpoint'});
 if(s.adapter==='external'&&!s.endpointKey)c.addIssue({code:'custom',message:'External adapters require a declared endpoint key'});
});
export const delegationContract=z.object({
 objective:z.string().trim().min(1).max(12000),
 requestedCapability:capability,
 successCriteria:z.array(z.string().trim().min(1).max(500)).min(1).max(20),
 budgetTokens:z.number().int().min(0).max(120000),
 deadline:z.string().datetime({offset:true}),
 correlationKey:z.string().min(5).max(128)
}).strict();
export const specialistReport=z.object({
 delegationId:z.string().uuid(),status:z.enum(['accepted','running','submitted','blocked']),
 progress:z.number().int().min(0).max(100),
 summary:z.string().min(1).max(2000),
 evidence:z.array(z.object({kind:z.enum(['artifact','source','test','review','blocker']),ref:z.string().min(1).max(500)}).strict()).max(30),
 deliverable:z.string().max(16000).optional(),
 blocker:z.string().max(2000).optional()
}).strict().superRefine((v,ctx)=>{
 if(v.status==='submitted'&&!v.deliverable)ctx.addIssue({code:'custom',message:'A submitted result must include a deliverable'});
 if(v.status==='blocked'&&!v.blocker)ctx.addIssue({code:'custom',message:'Blocked specialists must explain the blocker'});
});
export function selectSpecialist(specialists:Array<{slug:string;capabilities:string[];status:string}>,capabilityName:string){
 return specialists.filter(s=>s.status==='active'&&s.capabilities.includes(capabilityName)).sort((a,b)=>a.slug.localeCompare(b.slug));
}