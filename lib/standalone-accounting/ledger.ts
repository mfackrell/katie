import type { DailyUsage, UsageTotals } from './daily';
import type { PricingSnapshot } from './pricing';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import type { AdmitAttemptInput, ApprovalInput, LedgerAttempt, LedgerConfiguration, LedgerSnapshot, ResponseCheckpoint, SettlementInput } from './types';
export class StandaloneAccountingError extends Error {
  readonly terminal = true;
  readonly code:string;
  constructor(code:string,message=code) {super(message);this.name='StandaloneAccountingError';this.code=code.startsWith('standalone_')?code:`standalone_${code.toLowerCase()}`;}
}
export interface LedgerDatabase {rpc<T = unknown>(name:string,args:Record<string,unknown>):Promise<{data:T;error:{message:string}|null}>}
export function createStandaloneLedger(db:LedgerDatabase=getSupabaseAdminClient()) {
  async function rpc<T>(name:string,args:Record<string,unknown>):Promise<T> {
    const result=await db.rpc<T>(`standalone_${name}`,args);
    if(result.error) {
      const code=result.error.message.match(/STANDALONE_[A-Z_]+/)?.[0].toLowerCase() ?? 'standalone_ledger_unavailable';
      throw new StandaloneAccountingError(code,result.error.message);
    }
    if(result.data && typeof result.data==='object' && 'conflict' in result.data && result.data.conflict===true) {
      throw new StandaloneAccountingError('code' in result.data && typeof result.data.code==='string'?result.data.code:'standalone_receipt_conflict','Provider evidence conflicts with saved accounting. The conflict was saved for reconciliation.');
    }
    return result.data;
  }
  return {
    workflowStatus:(ownerId:string,requestId:string)=>rpc<{status:string;error?:string|null;error_message?:string|null}|null>('load_workflow',{p_owner:ownerId,p_request:requestId}),
    authorizeScope:(ownerId:string,actorId:string,chatId:string)=>rpc<boolean>('authorize_scope',{p_owner:ownerId,p_actor:actorId,p_chat:chatId}),
    bindScope:(ownerId:string,actorId:string,chatId:string)=>rpc<boolean>('bind_scope',{p_owner:ownerId,p_actor:actorId,p_chat:chatId}),
    loadPricing:(version:string|null)=>rpc<{snapshot:PricingSnapshot;retrievedAt:string}|null>('load_pricing',{p_version:version}),
    publishPricing:(version:string,snapshot:PricingSnapshot,sourceHash:string,rejected:Record<string,string>)=>rpc<boolean>('publish_pricing',{p_version:version,p_metadata:snapshot,p_source_hash:sourceHash,p_rejected:rejected}),
    createConversation:(ownerId:string,actorId:string,chatId:string,title:string)=>rpc<{id:string;actor_id:string;title:string;created_at:string;updated_at:string}>('create_conversation',{p_owner:ownerId,p_actor:actorId,p_chat:chatId,p_title:title}),
    registerPricing:(version:string,metadata:Record<string,unknown>)=>rpc<boolean>('register_pricing',{p_version:version,p_metadata:metadata}),
    configure:(ownerId:string,config:{timezone:string;perCallLimitMicrousd:string|null;requestLimitMicrousd:string|null})=>rpc<LedgerConfiguration>('configure',{p_owner:ownerId,p_timezone:config.timezone,p_call:config.perCallLimitMicrousd,p_request:config.requestLimitMicrousd}),
    readConfiguration:(ownerId:string)=>rpc<LedgerConfiguration|null>('read_configuration',{p_owner:ownerId}),
    usageSnapshot:(ownerId:string,actorId:string,chatId:string,all=false,before:string|null=null,beforeId:string|null=null)=>rpc<LedgerSnapshot & {daily:DailyUsage|null;flags:Record<string,{status?:string;error?:string;accepted:boolean;automatic:boolean;conflict:boolean}>;requestTotals:Record<string,UsageTotals>;alerts?:Array<{attemptId:string;provider:string;model:string;kind:string;message:string;actualMicrousd:string|null;reservedMicrousd:string}>}>('usage_snapshot',{p_owner:ownerId,p_actor:actorId,p_chat:chatId,p_all:all,p_before:before,p_before_id:beforeId}),
    attemptDetails:(ownerId:string,attemptId:string)=>rpc<LedgerSnapshot>('attempt_details',{p_owner:ownerId,p_attempt:attemptId}),
    requestUncertainties:(ownerId:string,requestId:string)=>rpc<Array<Pick<LedgerAttempt,'id'|'request_id'|'provider'|'model'|'state'>>>('request_uncertainties',{p_owner:ownerId,p_request:requestId}),
    recentActivity:(ownerId:string,actorId:string|null,before:string|null,beforeId:string|null)=>rpc<LedgerAttempt[]>('recent_activity',{p_owner:ownerId,p_actor:actorId,p_before:before,p_before_id:beforeId}),
    snapshot:(ownerId:string)=>rpc<LedgerSnapshot>('snapshot',{p_owner:ownerId}),
    lookupAttempt:(ownerId:string,requestId:string,attemptKey:string)=>rpc<LedgerAttempt|null>('lookup_attempt',{p_owner:ownerId,p_request:requestId,p_key:attemptKey}),
    admit:(i:AdmitAttemptInput)=>rpc<LedgerAttempt>('admit',{p_owner:i.ownerId,p_actor:i.actorId,p_chat:i.chatId,p_request:i.requestId,p_key:i.attemptKey,p_hash:i.preparedHash,p_payload:i.preparedPayload,p_pricing:i.pricingVersion,p_provider:i.provider,p_model:i.model,p_reserved:i.reservedMicrousd,p_category:i.category,p_estimate:i.preflightEstimate,p_estimator:i.estimatorVersion,p_reason:i.reason}),
    approve:(i:ApprovalInput)=>rpc<LedgerAttempt>('approve',{p_owner:i.ownerId,p_attempt:i.attemptId,p_hash:i.preparedHash,p_pricing:i.pricingVersion,p_revision:i.budgetRevision,p_reserved:i.reservedMicrousd}),
    revise:(ownerId:string,attemptId:string,input:{preparedHash:string;preparedPayload:Record<string,unknown>;pricingVersion:string;reservedMicrousd:string;tradeoffs:string;preflightEstimate:unknown;estimatorVersion:string})=>rpc<LedgerAttempt>('revise',{p_owner:ownerId,p_attempt:attemptId,p_hash:input.preparedHash,p_payload:input.preparedPayload,p_pricing:input.pricingVersion,p_reserved:input.reservedMicrousd,p_tradeoffs:input.tradeoffs,p_estimate:input.preflightEstimate,p_estimator:input.estimatorVersion}),
    reprice:(ownerId:string,attemptId:string,pricingVersion:string,estimate:Record<string,unknown>)=>rpc<LedgerAttempt>('reprice_attempt',{p_owner:ownerId,p_attempt:attemptId,p_pricing:pricingVersion,p_estimate:estimate}),
    claimDispatch:(ownerId:string,attemptId:string)=>rpc<LedgerAttempt|null>('claim_dispatch',{p_owner:ownerId,p_attempt:attemptId}),
    settle:(i:SettlementInput)=>rpc<LedgerAttempt>('settle',{p_owner:i.ownerId,p_attempt:i.attemptId,p_provider:i.provider,p_receipt:i.providerReceiptId,p_actual:i.actualMicrousd,p_usage:i.usage,p_evidence:i.evidence}),
    acceptUncertainExposure:(ownerId:string,attemptId:string,budgetRevision:number,reservedMicrousd:string)=>rpc<{accepted_at:string}>('accept_uncertain_exposure',{p_owner:ownerId,p_attempt:attemptId,p_revision:budgetRevision,p_reserved:reservedMicrousd}),
    uncertainExposureAccepted:(ownerId:string,attemptId:string)=>rpc<boolean>('uncertain_exposure_accepted',{p_owner:ownerId,p_attempt:attemptId}),
    completeQwenRejection:(ownerId:string,attemptId:string,checkpoint:ResponseCheckpoint)=>rpc<LedgerAttempt>('complete_qwen_rejection',{p_owner:ownerId,p_attempt:attemptId,p_checkpoint:checkpoint}),
    completeQwenEstimate:(ownerId:string,attemptId:string,jobId:string,checkpoint:ResponseCheckpoint,evidence:Record<string,unknown>)=>rpc<LedgerAttempt>('complete_qwen_estimate',{p_owner:ownerId,p_attempt:attemptId,p_job:jobId,p_checkpoint:checkpoint,p_evidence:evidence}),
    markUncertain:(ownerId:string,attemptId:string,reason='Provider outcome unknown')=>rpc<LedgerAttempt>('mark_uncertain',{p_owner:ownerId,p_attempt:attemptId,p_reason:reason}),
    cancel:(ownerId:string,attemptId:string)=>rpc<LedgerAttempt>('cancel',{p_owner:ownerId,p_attempt:attemptId}),
    recordPartialUsage:(ownerId:string,attemptId:string,usage:Record<string,unknown>,evidence:Record<string,unknown>)=>rpc<LedgerAttempt>('record_partial_usage',{p_owner:ownerId,p_attempt:attemptId,p_usage:usage,p_evidence:evidence}),
    recordProviderIdentifiers:(ownerId:string,attemptId:string,requestId:string|null,responseId:string|null)=>rpc<LedgerAttempt>('record_provider_identifiers',{p_owner:ownerId,p_attempt:attemptId,p_request_id:requestId,p_response_id:responseId}),
    checkpointResponse:(ownerId:string,attemptId:string,checkpoint:ResponseCheckpoint)=>rpc<LedgerAttempt>('checkpoint_response',{p_owner:ownerId,p_attempt:attemptId,p_checkpoint:checkpoint}),
  };
}
