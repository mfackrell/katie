import {z} from 'zod';
import {capability,selectSpecialist} from './contracts';
export const capabilityRequirement=z.object({
 capability,objective:z.string().trim().min(1).max(5000),
 successCriteria:z.array(z.string().trim().min(1).max(500)).min(1).max(20),
 proposedSlug:capability,proposedTitle:z.string().trim().min(3).max(100),
 proposedDescription:z.string().trim().min(10).max(2000),
 proposedCapabilities:z.array(capability).min(1).max(20)
}).strict().superRefine((v,c)=>{
 if(!v.proposedCapabilities.includes(v.capability))c.addIssue({code:'custom',message:'Proposed specialist must support the required capability'});
 if(new Set(v.proposedCapabilities).size!==v.proposedCapabilities.length)c.addIssue({code:'custom',message:'Duplicate capabilities'});
});
export type CapabilityRequirement=z.infer<typeof capabilityRequirement>;
export type AvailableSpecialist={id:string;slug:string;capabilities:string[];status:string;adapter:'mission'|'external';endpoint_key:string|null};
export type ProvisioningDecision=
 |{route:'reuse';specialistId:string;specialistSlug:string;capability:string}
 |{route:'configure';specialistSlug:string;capabilities:string[];capability:string}
 |{route:'commission';capability:string;specialistSlug:string;missingCapabilities:string[];reason:string};

// Only reuse ACTIVE specialists. Registration never implicitly authorizes
// execution; an available mission adapter can be configured without new code.
// All unknown capability implementations must be commissioned, not invented.
export function decideProvisioning(input:CapabilityRequirement,registered:AvailableSpecialist[],availableMissionCapabilities:string[]):ProvisioningDecision{
 const required=capabilityRequirement.parse(input);
 const existing=selectSpecialist(registered,required.capability)[0];
 if(existing)return{route:'reuse',specialistId:existing.id,specialistSlug:existing.slug,capability:required.capability};
 const available=new Set(availableMissionCapabilities.map(x=>capability.parse(x)));
 const missing=required.proposedCapabilities.filter(x=>!available.has(x));
 if(missing.length)return{route:'commission',capability:required.capability,specialistSlug:required.proposedSlug,
   missingCapabilities:missing,reason:'The existing authorized mission capability catalog cannot fulfill the complete proposed specialist contract.'};
 return{route:'configure',capability:required.capability,specialistSlug:required.proposedSlug,capabilities:required.proposedCapabilities};
}
