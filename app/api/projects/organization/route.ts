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
import {mission79RetryOffer} from '@/lib/projects/mission79-retry';
import {mission80WatchdogOffer,MISSION80_ID,MISSION80_ASSIGNMENT} from '@/lib/projects/mission80-watchdog';
import {mission82WatchdogOffer,MISSION82_ID,MISSION82_ASSIGNMENT} from '@/lib/projects/mission82-watchdog';
import {mission84ProviderRetryOffer,M84_PROVIDER_MISSION,M84_PROVIDER_ASSIGNMENT} from '@/lib/projects/mission84-provider-retry';
import {managementContextRetestOffer} from '@/lib/projects/management-context-retest';
import {followupManagementRetestOffer} from '@/lib/projects/management-followup-retest';
import {codingCapacityOffer} from '@/lib/projects/coding-capacity-recovery';
import {packageExecutionOffer,ORIGINAL_PACKAGE,matchesPackageTerms} from '@/lib/projects/package-execution-authorization';
import {originalBoundedRecoveryOffer,ORIGINAL_RECOVERY_MISSION,ORIGINAL_RECOVERY_ASSIGNMENT} from '@/lib/projects/original-bounded-recovery';
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
const mission79RetryApprovalInput=z.object({
 projectId:z.literal(ORIGINAL_TTT_PROJECT),
 trialAction:z.literal('authorize_mission79_failed_retry'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),
 releaseGeneration:z.number().int().positive(),
 deploymentId:z.string().regex(/^dpl_[A-Za-z0-9]+$/),
 missionId:z.literal(MISSION79_ID),assignmentId:z.literal(MISSION79_ASSIGNMENT),
 authorizationId:z.string().uuid(),
 cutoff:z.string().datetime({offset:true}),
 stateHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const mission79WatchdogRecoveryInput=z.object({
 projectId:z.literal(ORIGINAL_TTT_PROJECT),
 trialAction:z.literal('authorize_mission79_watchdog_recovery'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),
 releaseGeneration:z.number().int().positive(),
 deploymentId:z.string().regex(/^dpl_[A-Za-z0-9]+$/),
 missionId:z.literal(MISSION79_ID),assignmentId:z.literal(MISSION79_ASSIGNMENT),
 authorizationId:z.string().uuid(),priorAuthorizationId:z.string().uuid(),
 cutoff:z.string().datetime({offset:true}),
 stateHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const mission80WatchdogRecoveryInput=z.object({
 projectId:z.literal(ORIGINAL_TTT_PROJECT),
 trialAction:z.literal('authorize_mission80_watchdog_recovery'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),
 releaseGeneration:z.number().int().positive(),
 deploymentId:z.string().regex(/^dpl_[A-Za-z0-9]+$/),
 missionId:z.literal(MISSION80_ID),assignmentId:z.literal(MISSION80_ASSIGNMENT),
 authorizationId:z.string().uuid(),cutoff:z.string().datetime({offset:true}),
 stateHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const mission82WatchdogRecoveryInput=z.object({
 projectId:z.literal(ORIGINAL_TTT_PROJECT),
 trialAction:z.literal('authorize_mission82_watchdog_recovery'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),
 releaseGeneration:z.number().int().positive(),
 deploymentId:z.string().regex(/^dpl_[A-Za-z0-9]+$/),
 missionId:z.literal(MISSION82_ID),assignmentId:z.literal(MISSION82_ASSIGNMENT),
 authorizationId:z.string().uuid(),cutoff:z.string().datetime({offset:true}),
 stateHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const originalBoundedRecoveryInput=z.object({
 projectId:z.literal(ORIGINAL_TTT_PROJECT),
 trialAction:z.literal('authorize_original_bounded_recovery'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),
 releaseGeneration:z.number().int().positive(),
 deploymentId:z.string().regex(/^dpl_[A-Za-z0-9]+$/),
 scopeHash:z.literal('4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'),
 stateHash:z.string().regex(/^[a-f0-9]{64}$/),
 activeMissionId:z.literal(ORIGINAL_RECOVERY_MISSION),
 assignmentId:z.literal(ORIGINAL_RECOVERY_ASSIGNMENT),
 priorCutoff:z.literal('2026-11-22T14:00:00.000Z'),
 cutoff:z.string().datetime({offset:true}),
 authorizationId:z.string().uuid(),
 historicalMissions:z.literal(84),maxMissions:z.literal(96),
 tokenAllowance:z.literal(600000),additionalPaidRetries:z.literal(0)
}).strict();
const mission84ProviderRetryInput=z.object({
 projectId:z.literal(ORIGINAL_TTT_PROJECT),trialAction:z.literal('authorize_m84_provider_retry'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),releaseGeneration:z.number().int().positive(),
 deploymentId:z.string().regex(/^dpl_[A-Za-z0-9]+$/),
 scopeHash:z.literal('4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'),
 stateHash:z.string().regex(/^[a-f0-9]{64}$/),missionId:z.literal(M84_PROVIDER_MISSION),
 assignmentId:z.literal(M84_PROVIDER_ASSIGNMENT),
 originalRequestId:z.literal('58d5926a-7160-42c1-9a04-540351e777dc'),
 authorizationId:z.string().uuid(),cutoff:z.literal('2026-11-26T19:45:00.000Z'),
 originalAttempts:z.literal(1),newPaidAttempts:z.literal(1),
}).strict();
const contextRetestInput=z.object({
 projectId:z.literal(ORIGINAL_TTT_PROJECT),trialAction:z.literal('authorize_management_context_one_retest'),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),releaseGeneration:z.number().int().positive(),
 deploymentId:z.string().regex(/^dpl_[A-Za-z0-9]+$/),
 scopeHash:z.literal('4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'),
 stateHash:z.string().regex(/^[a-f0-9]{64}$/),contextHash:z.string().regex(/^[a-f0-9]{64}$/),
 contextChars:z.number().int().min(1).max(48000),
 missionId:z.string().uuid(),assignmentId:z.string().uuid(),
 authorizationId:z.string().uuid(),cutoff:z.string().datetime({offset:true}),
 historicalMissions:z.number().int().min(84).max(96),
 originalAttempts:z.literal(1),additionalAttempts:z.literal(1),
}).strict();
const followupRetestInput=contextRetestInput.extend({
 trialAction:z.literal('authorize_management_followup_one_retest')
}).strict();
const codingCapacityInput=z.object({
 trialAction:z.literal('authorize_coding_capacity'),projectId:z.literal(ORIGINAL_TTT_PROJECT),authorizationId:z.string().uuid(),
 releaseSha:z.string().regex(/^[a-f0-9]{40}$/),releaseGeneration:z.number().int().positive(),deploymentId:z.string().regex(/^dpl_[A-Za-z0-9]+$/),
 scopeHash:z.string().regex(/^[a-f0-9]{64}$/),stateHash:z.string().regex(/^[a-f0-9]{64}$/),cutoff:z.string().datetime({offset:true}),
 historicalMissions:z.union([z.literal(96),z.literal(98),z.literal(99),z.literal(102),z.literal(103)]),additionalMissions:z.number().int().min(1).max(8),maxMissions:z.number().int().min(97).max(104),
 priorAuthorizationId:z.string().uuid().optional(),sourceMissionId:z.string().uuid().optional(),sourceAssignmentId:z.string().uuid().optional(),
 paidInferenceLimit:z.number().int().min(1).max(8),paidInferenceConsent:z.literal(true),retryLimit:z.literal(0),
 tokenAllowance:z.literal(600000),remainingRecordedTokens:z.number().int().min(0).max(600000),additionalTokens:z.literal(0),additionalSpendingAuthority:z.literal(0),
}).strict();
const packageExecutionInput=z.object({trialAction:z.literal('authorize_existing_package_execution'),projectId:z.literal(ORIGINAL_TTT_PROJECT),packageId:z.literal(ORIGINAL_PACKAGE),authorizationId:z.string().uuid(),releaseSha:z.string().regex(/^[a-f0-9]{40}$/),releaseGeneration:z.number().int().positive(),deploymentId:z.string().regex(/^dpl_[A-Za-z0-9]+$/),stateHash:z.string().regex(/^[a-f0-9]{64}$/),terms:z.unknown().refine(matchesPackageTerms),paidInferenceConsent:z.literal(true)}).strict();
const input=z.union([packageExecutionInput,codingCapacityInput,followupRetestInput,contextRetestInput,mission84ProviderRetryInput,financialInput,providerTrialInput,directorRecoveryInput,continuationInput,renewalInput,hierarchyRecoveryInput,pausedRenewalInput,managementResumeInput,blockedWindowInput,blockedResumeInput,managementRetestInput,futureMission79WindowInput,bindMission79ReleaseInput,mission79RetryApprovalInput,mission79WatchdogRecoveryInput,mission80WatchdogRecoveryInput,mission82WatchdogRecoveryInput,originalBoundedRecoveryInput]);
export async function GET(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return NextResponse.json({error:'Authenticated owner session required'},{status:403});
 if(new URL(request.url).searchParams.get('projectId')!==ORIGINAL_TTT_PROJECT)
  return NextResponse.json({error:'Original project required'},{status:400});
 try{
   if(new URL(request.url).searchParams.get('packageId')===ORIGINAL_PACKAGE)
    return NextResponse.json({packageExecutionRecovery:await packageExecutionOffer(ORIGINAL_TTT_PROJECT)},{headers:{'Cache-Control':'no-store'}});
  try{return NextResponse.json({codingCapacityRecovery:await codingCapacityOffer(ORIGINAL_TTT_PROJECT)},{headers:{'Cache-Control':'no-store'}});}
  catch{ /* No new exhausted-project commissioning offer. */ }
  try{return NextResponse.json({followupManagementRetest:await followupManagementRetestOffer(ORIGINAL_TTT_PROJECT)},
   {headers:{'Cache-Control':'no-store'}});}
  catch{ /* Existing one-attempt followup is not presently owner-eligible. */ }
  try{return NextResponse.json({managementContextRetest:await managementContextRetestOffer(ORIGINAL_TTT_PROJECT)},
   {headers:{'Cache-Control':'no-store'}});}
  catch{ /* No current complete-context, signed one-attempt owner recovery. */ }
  try{return NextResponse.json({mission84ProviderRetry:await mission84ProviderRetryOffer(ORIGINAL_TTT_PROJECT)},
   {headers:{'Cache-Control':'no-store'}});}
  catch{ /* Exact original reconciled Mission84 owner approval not offered. */ }
  try{return NextResponse.json({originalBoundedRecovery:await originalBoundedRecoveryOffer(ORIGINAL_TTT_PROJECT)}, {headers:{'Cache-Control':'no-store'}});}
  catch{ /* Original exact 84-mission owner recovery not offered. */ }
  try{return NextResponse.json({mission82Recovery:await mission82WatchdogOffer(ORIGINAL_TTT_PROJECT)},
    {headers:{'Cache-Control':'no-store'}});}
  catch{ /* Original Mission82 independent escalation is not owner-recoverable. */ }
  try{return NextResponse.json({mission80Recovery:await mission80WatchdogOffer(ORIGINAL_TTT_PROJECT)},
    {headers:{'Cache-Control':'no-store'}});}
  catch{ /* This exact Mission80 signed recovery may not be applicable. */ }
  try{return NextResponse.json({mission79Retry:await mission79RetryOffer(ORIGINAL_TTT_PROJECT)},{headers:{'Cache-Control':'no-store'}});}
  catch{ /* No exact failed-attempt owner offer: use prior source-bound controls. */ }
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
 if('trialAction' in p&&p.trialAction==='authorize_existing_package_execution'){
  const offer=await packageExecutionOffer(p.projectId);
  if(offer.packageId!==p.packageId||offer.releaseSha!==p.releaseSha||offer.releaseGeneration!==p.releaseGeneration||offer.deploymentId!==p.deploymentId||offer.stateHash!==p.stateHash||!matchesPackageTerms(p.terms))return NextResponse.json({error:'Stale or changed package authority'},{status:409});
  const epoch=await rpc<{generation:number;active:boolean;deploymentId:string|null}>('project_org_retest_release_epoch',{p_project:p.projectId,p_release:p.releaseSha});
  const failure=mission79ReleaseIdentityFailure(epoch,{releaseGeneration:p.releaseGeneration,deploymentId:p.deploymentId},process.env.VERCEL_DEPLOYMENT_ID);
  if(failure)return NextResponse.json({error:mission79ReleaseIdentityMessage(failure),code:failure},{status:409});
  if(!await verifyMission79ActiveProductionSha(p.releaseSha,fetch,request.headers.get('cookie')))return NextResponse.json({error:'Exact canonical Katie production identity required'},{status:409});
  return NextResponse.json(await rpc('project_org_package_execution_authorize',{p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_package:p.packageId,p_release:p.releaseSha,p_generation:p.releaseGeneration,p_deployment:p.deploymentId,p_authorization:p.authorizationId,p_state_hash:p.stateHash,p_terms:p.terms,p_consent:p.paidInferenceConsent}),{headers:{'Cache-Control':'no-store'}});
 }
 if('trialAction' in p&&p.trialAction==='authorize_coding_capacity'){
  const offer=await codingCapacityOffer(p.projectId);
  if(offer.stage!=='authorize'||offer.releaseSha!==p.releaseSha||offer.releaseGeneration!==p.releaseGeneration
   ||offer.deploymentId!==p.deploymentId||offer.scopeHash!==p.scopeHash||offer.stateHash!==p.stateHash
   ||Date.parse(offer.cutoff)!==Date.parse(p.cutoff)||Date.now()>=Date.parse(offer.cutoff)-300000
   ||offer.historicalMissions!==p.historicalMissions
   ||p.maxMissions!==p.historicalMissions+p.additionalMissions||p.paidInferenceLimit!==p.additionalMissions
   ||(p.historicalMissions!==96?(p.additionalMissions!==(p.historicalMissions>=102?1:3)||p.maxMissions!==p.historicalMissions+(p.historicalMissions>=102?1:3)||p.priorAuthorizationId!==offer.priorAuthorizationId
     ||p.sourceMissionId!==offer.sourceMissionId||p.sourceAssignmentId!==offer.sourceAssignmentId||!p.priorAuthorizationId||!p.sourceMissionId||!p.sourceAssignmentId)
    :p.priorAuthorizationId!==undefined||p.sourceMissionId!==undefined||p.sourceAssignmentId!==undefined)
   ||p.remainingRecordedTokens!==offer.remainingRecordedTokens)
   return NextResponse.json({error:'Selected commissioning capacity or current authority changed'},{status:409});
  const epoch=await rpc<{generation:number;active:boolean;deploymentId:string|null}>('project_org_retest_release_epoch',{p_project:p.projectId,p_release:p.releaseSha});
  const failure=mission79ReleaseIdentityFailure(epoch,{releaseGeneration:p.releaseGeneration,deploymentId:p.deploymentId},process.env.VERCEL_DEPLOYMENT_ID);
  if(failure)return NextResponse.json({error:mission79ReleaseIdentityMessage(failure),code:failure},{status:409});
  if(!await verifyMission79ActiveProductionSha(p.releaseSha,fetch,request.headers.get('cookie')))
   return NextResponse.json({error:'Exact canonical Katie production identity required'},{status:409});
  return NextResponse.json(await rpc(p.historicalMissions!==96?'project_org_coding_capacity_resume_authorize':'project_org_coding_capacity_authorize',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_release:p.releaseSha,p_generation:p.releaseGeneration,p_deployment:p.deploymentId,
   p_authorization:p.authorizationId,p_state_hash:p.stateHash,p_scope:p.scopeHash,p_cutoff:p.cutoff,p_additional:p.additionalMissions,
   p_max:p.maxMissions,p_paid_limit:p.paidInferenceLimit,p_retry_limit:p.retryLimit,p_tokens:p.tokenAllowance,p_remaining:p.remainingRecordedTokens,
   ...(p.historicalMissions!==96?{p_prior_authorization:p.priorAuthorizationId,p_source_mission:p.sourceMissionId,p_source_assignment:p.sourceAssignmentId}:{})
  }),{headers:{'Cache-Control':'no-store'}});
 }
 if('trialAction' in p&&p.trialAction==='authorize_management_followup_one_retest'){
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
    return NextResponse.json({error:'Exact current production SHA required'},{status:409});
  const offer=await followupManagementRetestOffer(p.projectId);
  if(offer.stage!=='authorize'||offer.releaseSha!==p.releaseSha
   ||offer.releaseGeneration!==p.releaseGeneration||offer.deploymentId!==p.deploymentId
   ||offer.scopeHash!==p.scopeHash||offer.stateHash!==p.stateHash
   ||offer.contextHash!==p.contextHash||offer.contextChars!==p.contextChars
   ||offer.missionId!==p.missionId||offer.assignmentId!==p.assignmentId
   ||offer.historicalMissions!==p.historicalMissions
   ||Date.parse(offer.cutoff)!==Date.parse(p.cutoff)
   ||offer.originalAttempts!==1||offer.originalCalls!==0||offer.additionalAttempts!==1
   ||Date.now()>=Date.parse(offer.cutoff)-300000)
    return NextResponse.json({error:'Current management context, historical state or cutoff changed'},{status:409});
  const epoch=await rpc<{generation:number;active:boolean;deploymentId:string|null}>(
   'project_org_retest_release_epoch',{p_project:p.projectId,p_release:p.releaseSha});
  const failure=mission79ReleaseIdentityFailure(epoch,{
   releaseGeneration:p.releaseGeneration,deploymentId:p.deploymentId
  },process.env.VERCEL_DEPLOYMENT_ID);
  if(failure)return NextResponse.json({error:mission79ReleaseIdentityMessage(failure),code:failure},{status:409});
  if(!await verifyMission79ActiveProductionSha(p.releaseSha,fetch,request.headers.get('cookie')))
    return NextResponse.json({error:'Exact canonical Katie production identity required'},{status:409});
  return NextResponse.json(await rpc('project_org_followup_context_retest_authorize',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,
   p_release:p.releaseSha,p_generation:p.releaseGeneration,p_deployment:p.deploymentId,
   p_mission:p.missionId,p_assignment:p.assignmentId,
   p_authorization:p.authorizationId,p_state_hash:p.stateHash,
   p_context_hash:p.contextHash,p_context_chars:p.contextChars
  }),{headers:{'Cache-Control':'no-store'}});
 }
 if('trialAction' in p&&p.trialAction==='authorize_management_context_one_retest'){
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
    return NextResponse.json({error:'Exact current production SHA required'},{status:409});
  const offer=await managementContextRetestOffer(p.projectId);
  if(offer.stage!=='authorize'||offer.releaseSha!==p.releaseSha
   ||offer.releaseGeneration!==p.releaseGeneration||offer.deploymentId!==p.deploymentId
   ||offer.scopeHash!==p.scopeHash||offer.stateHash!==p.stateHash
   ||offer.contextHash!==p.contextHash||offer.contextChars!==p.contextChars
   ||offer.missionId!==p.missionId||offer.assignmentId!==p.assignmentId
   ||offer.historicalMissions!==p.historicalMissions
   ||Date.parse(offer.cutoff)!==Date.parse(p.cutoff)
   ||offer.originalAttempts!==1||offer.originalCalls!==0||offer.additionalAttempts!==1
   ||Date.now()>=Date.parse(offer.cutoff)-300000)
    return NextResponse.json({error:'Current management context, historical state or cutoff changed'},{status:409});
  const epoch=await rpc<{generation:number;active:boolean;deploymentId:string|null}>(
   'project_org_retest_release_epoch',{p_project:p.projectId,p_release:p.releaseSha});
  const failure=mission79ReleaseIdentityFailure(epoch,{
   releaseGeneration:p.releaseGeneration,deploymentId:p.deploymentId
  },process.env.VERCEL_DEPLOYMENT_ID);
  if(failure)return NextResponse.json({error:mission79ReleaseIdentityMessage(failure),code:failure},{status:409});
  if(!await verifyMission79ActiveProductionSha(p.releaseSha,fetch,request.headers.get('cookie')))
    return NextResponse.json({error:'Exact canonical Katie production identity required'},{status:409});
  return NextResponse.json(await rpc('project_org_context_retest_authorize',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,
   p_release:p.releaseSha,p_generation:p.releaseGeneration,p_deployment:p.deploymentId,
   p_mission:p.missionId,p_assignment:p.assignmentId,
   p_authorization:p.authorizationId,p_state_hash:p.stateHash,
   p_context_hash:p.contextHash,p_context_chars:p.contextChars
  }),{headers:{'Cache-Control':'no-store'}});
 }
 if('trialAction' in p&&p.trialAction==='authorize_m84_provider_retry'){
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
   return NextResponse.json({error:'Current canonical production release required'},{status:409});
  const offer=await mission84ProviderRetryOffer(p.projectId);
  if(offer.stage!=='authorize'||p.releaseSha!==offer.releaseSha||p.releaseGeneration!==offer.releaseGeneration
   ||p.deploymentId!==offer.deploymentId||p.scopeHash!==offer.scopeHash||p.stateHash!==offer.stateHash
   ||p.missionId!==offer.missionId||p.assignmentId!==offer.assignmentId
   ||p.originalRequestId!==offer.originalRequestId||Date.parse(p.cutoff)!==Date.parse(offer.cutoff)
   ||Date.parse(offer.cutoff)<=Date.now()+300000)
   return NextResponse.json({error:'Mission84 owner retry preflight or cutoff changed'},{status:409});
  const epoch=await rpc<{generation:number;active:boolean;deploymentId:string|null}>(
   'project_org_retest_release_epoch',{p_project:p.projectId,p_release:p.releaseSha});
  const failure=mission79ReleaseIdentityFailure(epoch,{releaseGeneration:p.releaseGeneration,
   deploymentId:p.deploymentId},process.env.VERCEL_DEPLOYMENT_ID);
  if(failure)return NextResponse.json({error:mission79ReleaseIdentityMessage(failure),code:failure},{status:409});
  if(!await verifyMission79ActiveProductionSha(p.releaseSha,fetch,request.headers.get('cookie')))
   return NextResponse.json({error:'Canonical original production SHA verification required'},{status:409});
  return NextResponse.json(await rpc('project_org_m84_provider_retry_authorize',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,p_release:p.releaseSha,
   p_generation:p.releaseGeneration,p_deployment:p.deploymentId,p_mission:p.missionId,
   p_assignment:p.assignmentId,p_authorization:p.authorizationId,p_state_hash:p.stateHash,
  }),{headers:{'Cache-Control':'no-store'}});
 }
 if('trialAction' in p&&p.trialAction==='authorize_original_bounded_recovery'){
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
   return NextResponse.json({error:'Exact current production release required'},{status:409});
  const offer=await originalBoundedRecoveryOffer(p.projectId);
  if(offer.stage!=='authorize'||offer.releaseSha!==p.releaseSha
   ||offer.releaseGeneration!==p.releaseGeneration||offer.deploymentId!==p.deploymentId
   ||offer.scopeHash!==p.scopeHash||offer.stateHash!==p.stateHash
   ||offer.activeMissionId!==p.activeMissionId||offer.assignmentId!==p.assignmentId
   ||Date.parse(offer.priorCutoff)!==Date.parse(p.priorCutoff))
   return NextResponse.json({error:'Signed recovery preflight or historical identity changed'},{status:409});
  const cutoff=Date.parse(p.cutoff);
  if(!Number.isFinite(cutoff)||cutoff<=Date.now()+30*60000
   ||cutoff>Date.now()+72*3600000)
   return NextResponse.json({error:'Explicit cutoff must be within the approved 30-minute to 72-hour window'},{status:400});
  const epoch=await rpc<{generation:number;active:boolean;deploymentId:string|null}>(
   'project_org_retest_release_epoch',{p_project:p.projectId,p_release:p.releaseSha});
  const failure=mission79ReleaseIdentityFailure(epoch,{
   releaseGeneration:p.releaseGeneration,deploymentId:p.deploymentId
  },process.env.VERCEL_DEPLOYMENT_ID);
  if(failure)return NextResponse.json({error:mission79ReleaseIdentityMessage(failure),code:failure},{status:409});
  if(!await verifyMission79ActiveProductionSha(p.releaseSha,fetch,request.headers.get('cookie')))
   return NextResponse.json({error:'Canonical Katie production SHA and deployment verification required'},{status:409});
  return NextResponse.json(await rpc('project_org_bounded_recovery_authorize',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,
   p_release:p.releaseSha,p_generation:p.releaseGeneration,p_deployment:p.deploymentId,
   p_authorization:p.authorizationId,p_cutoff:p.cutoff,p_state_hash:p.stateHash,
   p_mission:p.activeMissionId,p_assignment:p.assignmentId,
   p_max_missions:p.maxMissions,p_token_allowance:p.tokenAllowance,
   p_additional_retries:p.additionalPaidRetries
  }),{headers:{'Cache-Control':'no-store'}});
 }
 if('trialAction' in p&&p.trialAction==='authorize_mission82_watchdog_recovery'){
  // This action is submitted only by the authenticated first-party Katie
  // owner. A release migration or a stale Mission79 retry is NOT consent.
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
   return NextResponse.json({error:'Exact current production release required'},{status:409});
  const offer=await mission82WatchdogOffer(p.projectId);
  if(offer.stage!=='recover_watchdog'||offer.releaseSha!==p.releaseSha
   ||offer.releaseGeneration!==p.releaseGeneration||offer.deploymentId!==p.deploymentId
   ||offer.missionId!==p.missionId||offer.assignmentId!==p.assignmentId
   ||offer.stateHash!==p.stateHash||Date.parse(offer.cutoff)!==Date.parse(p.cutoff)
   ||Date.parse(offer.cutoff)<=Date.now()+300000)
   return NextResponse.json({error:'Original blocked Mission82 and unclaimed assignment required'},{status:409});
  const epoch=await rpc<{generation:number;active:boolean;deploymentId:string|null}>(
   'project_org_retest_release_epoch',{p_project:p.projectId,p_release:p.releaseSha});
  const failure=mission79ReleaseIdentityFailure(epoch,{
   releaseGeneration:p.releaseGeneration,deploymentId:p.deploymentId
  },process.env.VERCEL_DEPLOYMENT_ID);
  if(failure)return NextResponse.json({error:mission79ReleaseIdentityMessage(failure),code:failure},{status:409});
  if(!await verifyMission79ActiveProductionSha(p.releaseSha,fetch,request.headers.get('cookie')))
   return NextResponse.json({error:'Canonical production identity verification required for Mission82 recovery'},{status:409});
  return NextResponse.json(await rpc('project_org_mission82_watchdog_recover',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,
   p_release:p.releaseSha,p_mission:p.missionId,p_assignment:p.assignmentId,
   p_authorization:p.authorizationId,p_cutoff:p.cutoff,p_state_hash:p.stateHash,
   p_generation:p.releaseGeneration,p_deployment:p.deploymentId
  }),{headers:{'Cache-Control':'no-store'}});
 }
 if('trialAction' in p&&p.trialAction==='authorize_mission80_watchdog_recovery'){
  // This action is submitted only by the authenticated first-party Katie
  // owner. A release migration or a stale Mission79 retry is NOT consent.
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
   return NextResponse.json({error:'Exact current production release required'},{status:409});
  const offer=await mission80WatchdogOffer(p.projectId);
  if(offer.stage!=='recover_watchdog'||offer.releaseSha!==p.releaseSha
   ||offer.releaseGeneration!==p.releaseGeneration||offer.deploymentId!==p.deploymentId
   ||offer.missionId!==p.missionId||offer.assignmentId!==p.assignmentId
   ||offer.stateHash!==p.stateHash||Date.parse(offer.cutoff)!==Date.parse(p.cutoff)
   ||Date.parse(offer.cutoff)<=Date.now()+300000)
   return NextResponse.json({error:'Original blocked Mission80 and unclaimed assignment required'},{status:409});
  const epoch=await rpc<{generation:number;active:boolean;deploymentId:string|null}>(
   'project_org_retest_release_epoch',{p_project:p.projectId,p_release:p.releaseSha});
  const failure=mission79ReleaseIdentityFailure(epoch,{
   releaseGeneration:p.releaseGeneration,deploymentId:p.deploymentId
  },process.env.VERCEL_DEPLOYMENT_ID);
  if(failure)return NextResponse.json({error:mission79ReleaseIdentityMessage(failure),code:failure},{status:409});
  if(!await verifyMission79ActiveProductionSha(p.releaseSha,fetch,request.headers.get('cookie')))
   return NextResponse.json({error:'Canonical production identity verification required for Mission80 recovery'},{status:409});
  return NextResponse.json(await rpc('project_org_mission80_watchdog_recover',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,
   p_release:p.releaseSha,p_mission:p.missionId,p_assignment:p.assignmentId,
   p_authorization:p.authorizationId,p_cutoff:p.cutoff,p_state_hash:p.stateHash,
   p_generation:p.releaseGeneration,p_deployment:p.deploymentId
  }),{headers:{'Cache-Control':'no-store'}});
 }
 if('trialAction' in p&&p.trialAction==='authorize_mission79_watchdog_recovery'){
  // A new deployment invalidates the old retry release binding. This new
  // owner action only restores the original queued attempt, never creates a
  // new mission, window, receipt for another retry, or paid provider request.
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
   return NextResponse.json({error:'Exact current production release required'},{status:409});
  const offer=await mission79RetryOffer(p.projectId);
  if(offer.stage!=='recover_watchdog'||offer.releaseSha!==p.releaseSha
   ||offer.releaseGeneration!==p.releaseGeneration||offer.deploymentId!==p.deploymentId
   ||offer.missionId!==p.missionId||offer.assignmentId!==p.assignmentId
   ||offer.priorAuthorizationId!==p.priorAuthorizationId
   ||offer.stateHash!==p.stateHash||Date.parse(offer.cutoff)!==Date.parse(p.cutoff)
   ||Date.parse(offer.cutoff)<=Date.now()+300000)
   return NextResponse.json({error:'Existing one-time retry and exact watchdog state required'},{status:409});
  const epoch=await rpc<{generation:number;active:boolean;deploymentId:string|null}>(
   'project_org_retest_release_epoch',{p_project:p.projectId,p_release:p.releaseSha});
  const failure=mission79ReleaseIdentityFailure(epoch,{
   releaseGeneration:p.releaseGeneration,deploymentId:p.deploymentId
  },process.env.VERCEL_DEPLOYMENT_ID);
  if(failure)return NextResponse.json({error:mission79ReleaseIdentityMessage(failure),code:failure},{status:409});
  if(!await verifyMission79ActiveProductionSha(p.releaseSha,fetch,request.headers.get('cookie')))
   return NextResponse.json({error:'Canonical production release verification required for watchdog recovery'},{status:409});
  return NextResponse.json(await rpc('project_org_mission79_watchdog_recover',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,
   p_release:p.releaseSha,p_mission:p.missionId,p_assignment:p.assignmentId,
   p_authorization:p.authorizationId,p_prior_authorization:p.priorAuthorizationId,
   p_cutoff:p.cutoff,p_state_hash:p.stateHash,
   p_generation:p.releaseGeneration,p_deployment:p.deploymentId
  }),{headers:{'Cache-Control':'no-store'}});
 }
 if('trialAction' in p&&p.trialAction==='authorize_mission79_failed_retry'){
  // Owner authorization is distinct from the prior window and the release
  // operator. Neither rendering the offer nor deploying code admits paid work.
  if(process.env.VERCEL_ENV!=='production'||p.releaseSha!==process.env.VERCEL_GIT_COMMIT_SHA)
   return NextResponse.json({error:'Exact current production release required'},{status:409});
  const offer=await mission79RetryOffer(p.projectId);
  if(offer.stage!=='approve_retry'||offer.releaseSha!==p.releaseSha
   ||offer.releaseGeneration!==p.releaseGeneration||offer.deploymentId!==p.deploymentId
   ||offer.missionId!==p.missionId||offer.assignmentId!==p.assignmentId
   ||offer.stateHash!==p.stateHash||Date.parse(offer.cutoff)!==Date.parse(p.cutoff)
   ||Date.parse(offer.cutoff)<=Date.now()+300000)
   return NextResponse.json({error:'One original failed attempt and future owner cutoff required'},{status:409});
  const epoch=await rpc<{generation:number;active:boolean;deploymentId:string|null}>(
   'project_org_retest_release_epoch',{p_project:p.projectId,p_release:p.releaseSha});
  const error=mission79ReleaseIdentityFailure(epoch,{
   releaseGeneration:p.releaseGeneration,deploymentId:p.deploymentId
  },process.env.VERCEL_DEPLOYMENT_ID);
  if(error)return NextResponse.json({error:mission79ReleaseIdentityMessage(error),code:error},{status:409});
  if(!await verifyMission79ActiveProductionSha(p.releaseSha,fetch,request.headers.get('cookie')))
   return NextResponse.json({error:'Canonical production release verification required for one retry'},{status:409});
  return NextResponse.json(await rpc('project_org_mission79_retry_authorize',{
   p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:p.projectId,
   p_release:p.releaseSha,p_mission:p.missionId,p_assignment:p.assignmentId,
   p_authorization:p.authorizationId,p_cutoff:p.cutoff,p_state_hash:p.stateHash,
   p_generation:p.releaseGeneration,p_deployment:p.deploymentId,
  }),{headers:{'Cache-Control':'no-store'}});
 }
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
