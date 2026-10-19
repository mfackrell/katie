import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {capabilityRequirement,decideProvisioning,type AvailableSpecialist,type CapabilityRequirement} from './provisioning';
import {z} from 'zod';
export type ProvisionRequest={actorId:string;chatId:string;requestKey:string;requirement:CapabilityRequirement};
// Called only by the trusted Executive Orchestrator service. No browser write
// endpoint or arbitrary specialist endpoint URL is exposed.
export async function planExecutiveProvisioning(input:ProvisionRequest){
 const requirement=capabilityRequirement.parse(input.requirement);
 const db=getSupabaseAdminClient();
 const {data,error}=await db.from('executive_orchestrators').select('id,slug,capabilities,status,adapter,endpoint_key')
  .eq('actor_id',input.actorId).limit(100);
 if(error)throw Error('Specialist capability inventory unavailable');
 const specialists=(data??[]) as AvailableSpecialist[];
 // A mission capability exists only if the caller has explicitly registered
 // a verified, ACTIVE mission adapter claiming that capability.
 const missionCapabilities=[...new Set(specialists.filter(s=>s.status==='active'&&s.adapter==='mission')
  .flatMap(s=>s.capabilities))];
 const decision=decideProvisioning(requirement,specialists,missionCapabilities);
 const valid=z.string().uuid();
 valid.parse(input.actorId);valid.parse(input.chatId);
 if(typeof input.requestKey!=='string'||input.requestKey.length<5||input.requestKey.length>128)
  throw Error('Invalid durable executive request key');
 const {data:request,error:rpcError}=await db.rpc('propose_executive_provisioning',{
  p_actor:input.actorId,p_chat:input.chatId,p_request:input.requestKey,
  p_requirement:requirement,p_route:decision.route,
  p_specialist:decision.route==='reuse'?decision.specialistId:null
 });
 if(rpcError||!request)throw Error('Provisioning request could not be recorded');
 return {decision,request};
}
export async function configureExecutiveSpecialist(input:{actorId:string;chatId:string;requestId:string;capabilityCatalogVerified:boolean}){
 if(!input.capabilityCatalogVerified)throw Error('Capability inventory must be independently verified');
 const db=getSupabaseAdminClient();
 const {data,error}=await db.rpc('transition_executive_provisioning',{
  p_id:input.requestId,p_actor:input.actorId,p_chat:input.chatId,p_action:'configure',
  p_evidence:{capabilityCatalogVerified:true}
 });
 if(error||!data)throw Error('Specialist configuration not authorized');
 return data;
}
// The commissioning handoff deliberately uses the existing executive
// delegation contract, not the software-development orchestrator internals.
// A specialist with verified 'specialist_build' capability must be active.
export async function bindSpecialistCommission(input:{actorId:string;chatId:string;requestId:string;commissionDelegationId:string}){
 const db=getSupabaseAdminClient();
 const {data,error}=await db.rpc('transition_executive_provisioning',{
  p_id:input.requestId,p_actor:input.actorId,p_chat:input.chatId,p_action:'bind_commission',
  p_evidence:{commissionDelegationId:input.commissionDelegationId}
 });
 if(error||!data)throw Error('A verified specialist builder delegation is required');
 return data;
}