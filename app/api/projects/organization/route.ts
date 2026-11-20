import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';
import {rpc} from '@/lib/missions/store';
import {managementActivationOffer,ORIGINAL_TTT_PROJECT,APPROVED_TTT_CUTOFF} from '@/lib/projects/management-activation';
import {blockedOwnerRecoveryOffer,ORIGINAL_BLOCKED_CUTOFF,ORIGINAL_BLOCKED_WINDOW} from '@/lib/projects/blocked-owner-recovery';
import {blockedManagementRetestOffer,BLOCKED_RETEST_SOURCE,BLOCKED_RETEST_WINDOW,BLOCKED_RETEST_CUTOFF} from '@/lib/projects/blocked-management-retest';
import {getMessages} from '@/lib/data/persistence-store';
import {mission79FutureWindowOffer,MISSION79_ID,MISSION79_ASSIGNMENT} from '@/lib/projects/mission79-future-window';
import {verifyMission79ActiveProductionSha} from '@/lib/projects/mission79-active-release';
import {mission79ReleaseIdentityFailure,mission79ReleaseIdentityMessage} from '@/lib/projects/mission79-release-identity';
const financialInput=z.object({projectId:z.string().uuid(),autonomousExecution:z.literal(true),objectiveHash:z.string().regex(/^[a-f0-9]{64}$/),ceilingMicrousd:z.number().int().positive().max(1_000_000_000),perCallMicrousd:z.number().int().positive()}).strict();
const providerTrialInput=z.object({actorId:z.string().uuid(),chatId:z.string().uuid(),trialAction:z.enum(['start','stop'])}).strict();
const directorRecoveryInput=z.object({
 projectId:z.string().uuid(),trialAction:z.literal('recover_director_once'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),cutoff:z.string().datetime({offset:true}),
 priorCutoff:z.string().datetime({offset:true}).optional(),
}).strict();
const continuationInput=z.object({projectId:z.string().uuid(),trialAction:z.literal('continue'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),decisionId:z.string().uuid(),cutoff:z.string().datetime({offset:true})}).strict();
const renewalInput=continuationInput.extend({trialAction:z.literal('renew_continue'),
 priorCutoff:z.string().datetime({offset:true}),authorizationId:z.string().uuid()}).strict();
const hierarchyRecoveryInput=z.object({
 projectId:z.string().uuid(),trialAction:z.literal('recover_hierarchy'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),decisionId:z.string().uuid(),
 priorCutoff:z.string().datetime({offset:true}),directorCutoff:z.string().datetime({offset:true}),
 cutoff:z.string().datetime({offset:true}),authorizationId:z.string().uuid(),
 stateHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
// This route exposes only the specific owner-approved #1050 deadline change.
// The SQL RPC separately checks the exact locked project/window/source state.
const pausedRenewalInput=z.object({
 projectId:z.literal('fe9d2658-41e3-44c1-ae8e-a0cba98371fe'),trialAction:z.literal('renew_paused_window'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),
 expectedReleaseSha:z.literal('c1d9a5f1ac10396c3015a7d5ae5f22254502e5de'),
 scopeHash:z.literal('4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'),
 sourceMissionId:z.literal('62cd8da3-1bcc-41ae-9470-574c6b05e420'),
 priorWindowId:z.literal('a837004e-75d3-497d-b05a-482886ed5a5f'),
 priorCutoff:z.literal('2026-11-15T18:00:00Z'),cutoff:z.literal('2026-11-16T18:00:00Z'),
 authorizationId:z.string().uuid(),stateHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const managementResumeInput=z.object({
 projectId:z.literal(ORIGINAL_TTT_PROJECT),trialAction:z.literal('resume_management'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),authorizationId:z.string().uuid(),
 stateHash:z.string().regex(/^[a-f0-9]{64}$/),cutoff:z.literal(APPROVED_TTT_CUTOFF),
}).strict();
const blockedWindowInput=z.object({
 projectId:z.literal(ORIGINAL_TTT_PROJECT),trialAction:z.literal('authorize_blocked_window'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),
 priorWindowId:z.literal(ORIGINAL_BLOCKED_WINDOW),priorCutoff:z.literal(ORIGINAL_BLOCKED_CUTOFF),
 cutoff:z.string().datetime({offset:true}),authorizationId:z.string().uuid(),
 stateHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const blockedResumeInput=z.object({
 projectId:z.literal(ORIGINAL_TTT_PROJECT),trialAction:z.literal('resume_blocked_management'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),authorizationId:z.string().uuid(),
 cutoff:z.string().datetime({offset:true}),stateHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const managementRetestInput=z.object({
 projectId:z.literal(ORIGINAL_TTT_PROJECT),trialAction:z.literal('retest_blocked_management'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),
 sourceMissionId:z.literal(BLOCKED_RETEST_SOURCE),windowId:z.literal(BLOCKED_RETEST_WINDOW),
 cutoff:z.literal(BLOCKED_RETEST_CUTOFF),stateHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const futureMission79WindowInput=z.object({
 projectId:z.literal(ORIGINAL_TTT_PROJECT),
 trialAction:z.literal('authorize_mission79_future_window'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),
 missionId:z.literal(MISSION79_ID),assignmentId:z.literal(MISSION79_ASSIGNMENT),
 authorizationId:z.string().uuid(),cutoff:z.string().datetime({offset:true}),
 releaseGeneration:z.number().int().positive(),deploymentId:z.string().regex(/^dpl_[A-Za-z0-9]+$/),
 stateHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const bindMission79ReleaseInput=z.object({
 projectId:z.literal(ORIGINAL_TTT_PROJECT),trialAction:z.literal('bind_mission79_release'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),
 missionId:z.literal(MISSION79_ID),assignmentId:z.literal(MISSION79_ASSIGNMENT),
 releaseGeneration:z.number().int().positive(),deploymentId:z.string().regex(/^dpl_[A-Za-z0-9]+$/),
 stateHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const input=z.union([financialInput,providerTrialInput,directorRecoveryInput,continuationInput,renewalInput,hierarchyRecoveryInput,pausedRenewalInput,managementResumeInput,blockedWindowInput,blockedResumeInput,managementRetestInput,futureMission79WindowInput,bindMission79ReleaseInput]);
export async function GET(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return NextResponse.json({error:'Authenticated owner session required'},{status:403});
 if(new URL(request.url).searchParams.get('projectId')!==ORIGINAL_TTT_PROJECT)
  return NextResponse.json({error:'Original project required'},{status:400});
 try{
  try{return NextResponse.json({mission79FutureWindow:await mission79FutureWindowOffer(ORIGINAL_TTT_PROJECT)},{headers:{'Cache-Control':'no-store'}});}
  catch{
  try{return NextResponse.json({managementRetest:await blockedManagementRetestOffer(ORIGINAL_TTT_PROJECT)},{headers:{'Cache-Control':'no-store'}});}
  catch{
   try{return NextResponse.json({managementActivation:await managementActivationOffer(ORIGINAL_TTT_PROJECT)},{headers:{'Cache-Control':'no-store'}});}
   catch{return NextResponse.json({blockedOwnerRecovery:await blockedOwnerRecoveryOffer(ORIGINAL_TTT_PROJECT)},{headers:{'Cache-Control':'no-store'}});}
  }
  }
 }
 catch{return NextResponse.json({error:'Recovery state unavailable or changed. Refresh project status; no activation was performed.'},{status:409});}
}
// Neither workers nor cron can activate either kind of owner authority.
export async function POST(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return NextResponse.json({error:'Authenticated owner session required'},{status:403});
 const parsed=input.safeParse(await request.json().catch(()=>null));
 if(!parsed.success)return NextResponse.json({error:'Invalid project authority request'},{status:400});
 const p=parsed.data;
 try{
 if('trialAction' in p&&p.trialAction==='authorize_mission79_future_window'){
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
   return NextResponse.json({error:'Exact READY production release is required'},{status:409});
  const releaseEpoch=await rpc<{generation:number;active:boolean;deploymentId:string|null}>('project_org_retest_release_epoch',{
   p_project:p.projectId,p_release:p.releaseSha
  });
  if(!releaseEpoch?.active)
   return NextResponse.json({error:'Current production deployment does not match the original mission79 release gate.',
    code:'mission79_release_mismatch'},{status:409});
  const offer=await mission79FutureWindowOffer(p.projectId);
  const next=Date.parse(p.cutoff);
  if(offer.stage!=='authorize'||offer.stateHash!==p.stateHash
   ||offer.releaseGeneration!==p.releaseGeneration||offer.deploymentId!==p.deploymentId
   ||offer.missionId!==p.missionId||offer.assignmentId!==p.assignmentId
   ||!Number.isFinite(next)||next<=Date.now()+300000||next>Date.now()+86400000
   ||next<=Date.parse(offer.priorCutoff))
   return NextResponse.json({error:'Explicit fresh future cutoff and original owner preflight are required'},{status:409});
  const identity=await rpc<{generation:number;active:boolean;deploymentId:string|null}>('project_org_retest_release_epoch',{
   p_project:p.projectId,p_release:p.releaseSha
  });
  const releaseFailure=mission79ReleaseIdentityFailure(identity,{
   releaseGeneration:p.releaseGeneration,deploymentId:p.deploymentId
  },process.env.VERCEL_DEPLOYMENT_ID);
  if(releaseFailure)return NextResponse.json({
   error:mission79ReleaseIdentityMessage(releaseFailure),code:releaseFailure
  },{status:409});
  if(!await verifyMission79ActiveProductionSha(p.releaseSha,fetch,request.headers.get('cookie')))
   return NextResponse.json({error:'The canonical Katie production alias no longer serves this exact authorization release'},{status:409});
  return NextResponse.json(await rpc('project_org_authorize_retest_future_window',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,
   p_release:p.releaseSha,p_mission:p.missionId,p_assignment:p.assignmentId,
   p_authorization:p.authorizationId,p_cutoff:p.cutoff,
   p_state_hash:p.stateHash,p_epoch:p.releaseGeneration,p_deployment:p.deploymentId,
  }),{headers:{'Cache-Control':'no-store'}});
 }
 if('trialAction' in p&&p.trialAction==='bind_mission79_release'){
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
   return NextResponse.json({error:'Release binding requires the exact current deployed production SHA'},{status:409});
  const owner=await mission79FutureWindowOffer(p.projectId);
  if(owner.stage!=='authorized'||owner.releaseSha!==p.releaseSha
    ||owner.releaseGeneration!==p.releaseGeneration||owner.deploymentId!==p.deploymentId
    ||owner.missionId!==p.missionId||owner.assignmentId!==p.assignmentId
    ||!owner.cutoff||Date.parse(owner.cutoff)<=Date.now()+300000)
   return NextResponse.json({error:'An explicit unexpired original-owner execution window is required'},{status:409});
  const offer=await rpc<{stage:string;projectId:string;releaseSha:string;missionId:string;assignmentId:string;cutoff:string;stateHash:string}>('project_org_retest_claim_release_offer',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_release:p.releaseSha
  });
  if(!offer||offer.stage!=='bind'||offer.projectId!==p.projectId
   ||offer.releaseSha!==p.releaseSha||offer.missionId!==p.missionId
   ||offer.assignmentId!==p.assignmentId||offer.stateHash!==p.stateHash
   ||Date.parse(offer.cutoff)!==Date.parse(owner.cutoff)
   ||Date.parse(offer.cutoff)<=Date.now()+300000)
   return NextResponse.json({error:'Exact source-bound release state changed; no worker was restarted'},{status:409});
  const identity=await rpc<{generation:number;active:boolean;deploymentId:string|null}>('project_org_retest_release_epoch',{
   p_project:p.projectId,p_release:p.releaseSha
  });
  const bindingReleaseFailure=mission79ReleaseIdentityFailure(identity,{
   releaseGeneration:p.releaseGeneration,deploymentId:p.deploymentId
  },process.env.VERCEL_DEPLOYMENT_ID);
  if(bindingReleaseFailure)return NextResponse.json({
   error:mission79ReleaseIdentityMessage(bindingReleaseFailure),code:bindingReleaseFailure
  },{status:409});
  if(!await verifyMission79ActiveProductionSha(p.releaseSha,fetch,request.headers.get('cookie')))
   return NextResponse.json({error:'The canonical Katie production alias no longer serves this exact binding release'},{status:409});
  return NextResponse.json(await rpc('project_org_bind_retest_claim_release',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_release:p.releaseSha,
   p_mission:p.missionId,p_assignment:p.assignmentId,p_state_hash:p.stateHash,
   p_epoch:p.releaseGeneration,p_deployment:p.deploymentId
  }),{headers:{'Cache-Control':'no-store'}});
 }
 if('trialAction' in p&&p.trialAction==='retest_blocked_management'){
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
   return NextResponse.json({error:'The exact deployed production release is required'},{status:409});
  const offer=await blockedManagementRetestOffer(p.projectId);
  if(offer.stage!=='retest'||p.stateHash!==offer.stateHash
   ||p.sourceMissionId!==offer.sourceMissionId||p.windowId!==offer.windowId
   ||Date.parse(p.cutoff)!==Date.parse(offer.cutoff)
   ||Date.now()>=Date.parse(offer.cutoff)-300000)
   return NextResponse.json({error:'One-time management retest offer changed or expired'},{status:409});
  return NextResponse.json(await rpc('project_org_resume_blocked_management_once',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_release:p.releaseSha,
   p_source_mission:p.sourceMissionId,p_window:p.windowId,p_cutoff:p.cutoff,p_state_hash:p.stateHash,
  }),{headers:{'Cache-Control':'no-store'}});
 }
 if('trialAction' in p&&(p.trialAction==='authorize_blocked_window'||p.trialAction==='resume_blocked_management')){
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
   return NextResponse.json({error:'The exact active production release is required'},{status:409});
  const offer=await blockedOwnerRecoveryOffer(p.projectId);
  if(offer.stage!==(p.trialAction==='authorize_blocked_window'?'authorize':'resume')
   ||p.stateHash!==offer.stateHash)
   return NextResponse.json({error:'Current owner recovery state changed; refresh the offer'},{status:409});
  if(p.trialAction==='authorize_blocked_window'){
   const next=Date.parse(p.cutoff);
   if(!Number.isFinite(next)||next<=Date.now()+300000||next>Date.now()+86400000)
    return NextResponse.json({error:'Explicit cutoff must be more than five minutes and at most 24 hours ahead'},{status:409});
   return NextResponse.json(await rpc('project_org_authorize_blocked_owner_window',{
    p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_release:p.releaseSha,
    p_prior_window:p.priorWindowId,p_prior_cutoff:p.priorCutoff,p_cutoff:p.cutoff,
    p_authorization:p.authorizationId,p_state_hash:p.stateHash,
   }));
  }
  if(!offer.cutoff||Date.parse(offer.cutoff)<=Date.now()+300000||Date.parse(p.cutoff)!==Date.parse(offer.cutoff))
   return NextResponse.json({error:'Authorized window expired or changed; no resume performed'},{status:409});
  return NextResponse.json(await rpc('project_org_resume_blocked_owner_confirmed',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_release:p.releaseSha,
   p_authorization:p.authorizationId,p_cutoff:p.cutoff,p_state_hash:p.stateHash,
  }));
 }
 if('trialAction' in p&&p.trialAction==='resume_management'){
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
   return NextResponse.json({error:'Management resume requires the exact active production release'},{status:409});
  if(Date.now()>=Date.parse(APPROVED_TTT_CUTOFF)-300000)
   return NextResponse.json({error:'The approved November 16 noon Central cutoff has expired or has less than five minutes remaining.'},{status:409});
  return NextResponse.json(await rpc('project_org_resume_management_confirmed',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_release:p.releaseSha,
   p_authorization:p.authorizationId,p_state_hash:p.stateHash,
  }));
 }
 if('trialAction' in p&&p.trialAction==='renew_paused_window'){
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
   return NextResponse.json({error:'Paused renewal requires the exact active production release'},{status:409});
  if(Date.now()>=Date.parse(APPROVED_TTT_CUTOFF)-300000)
   return NextResponse.json({error:'The approved November 16 noon Central cutoff has expired or has less than five minutes remaining.'},{status:409});
  // Retried HTTP requests verify an existing receipt; they never resume work.
  const recorded=await managementActivationOffer(p.projectId);
  if(recorded.stage==='resume'&&recorded.authorizationId===p.authorizationId&&recorded.renewalStateHash===p.stateHash)
   return NextResponse.json({projectId:p.projectId,authorizationId:p.authorizationId,sourceMissionId:recorded.sourceMissionId,
    releaseSha:recorded.releaseSha,cutoff:recorded.cutoff,status:'paused',historicalMissions:recorded.historicalMissions,existing:true});
  return NextResponse.json(await rpc('project_org_renew_paused_window',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_release:p.releaseSha,
   p_expected_release:p.expectedReleaseSha,p_scope_hash:p.scopeHash,p_source_mission:p.sourceMissionId,
   p_prior_window:p.priorWindowId,p_prior_cutoff:p.priorCutoff,p_cutoff:p.cutoff,
   p_authorization:p.authorizationId,p_state_hash:p.stateHash,
  }));
 }
 if('trialAction' in p&&p.trialAction==='recover_hierarchy'){
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
   return NextResponse.json({error:'Hierarchy recovery requires the exact active production release'},{status:409});
  return NextResponse.json(await rpc('project_org_recover_hierarchy',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_release:p.releaseSha,
   p_decision:p.decisionId,p_prior_cutoff:p.priorCutoff,p_director_cutoff:p.directorCutoff,
   p_cutoff:p.cutoff,p_authorization:p.authorizationId,p_state_hash:p.stateHash,
  }));
 }
 if('trialAction' in p&&(p.trialAction==='continue'||p.trialAction==='renew_continue')){
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
   return NextResponse.json({error:'Continuation requires the exact active production release'},{status:409});
  const args={p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_release:p.releaseSha,p_decision:p.decisionId,p_cutoff:p.cutoff};
  return NextResponse.json(p.trialAction==='renew_continue'
   ?await rpc('project_org_renew_continue',{...args,p_prior_cutoff:p.priorCutoff,p_authorization:p.authorizationId})
   :await rpc('project_provider_continue',args));
 }
 if('trialAction' in p&&p.trialAction==='recover_director_once'){
  if(p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)return NextResponse.json({error:'Recovery requires the exact active production release'},{status:409});
  const args={p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_release:p.releaseSha,p_cutoff:p.cutoff};
  const admission=p.priorCutoff
   ?await rpc('project_admit_expired_director_recovery',{...args,p_prior_cutoff:p.priorCutoff})
   :await rpc('project_admit_director_recovery',args);
  return NextResponse.json(admission);
 }
 if('trialAction' in p){
  const project=await rpc<{id:string;status:string}>(
   p.trialAction==='start'?'project_provider_launch':'project_provider_owner_stop',
   {p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_actor:p.actorId,p_chat:p.chatId});
  return NextResponse.json({projectId:project.id,status:project.status,messages:await getMessages(p.chatId).catch(()=>undefined)});
 }
 await rpc('project_org_authorize',{p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_objective_hash:p.objectiveHash,p_ceiling:p.ceilingMicrousd,p_per_call:p.perCallMicrousd,p_autonomous:p.autonomousExecution});
 return NextResponse.json({authorized:true});
 }catch{return NextResponse.json({error:'trialAction' in p&&['renew_paused_window','resume_management','retest_blocked_management','authorize_mission79_future_window','bind_mission79_release'].includes(p.trialAction)
  ?'Recovery state changed or the request could not be confirmed. Refresh recovery status before continuing.'
  :'Owner binding, project objective or execution authority changed'},{status:409});}
}
