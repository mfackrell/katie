/** Integer millionths of one USD. Never a floating point dollar amount. */
export type Microusd = string;
export type LedgerAttemptState = 'paused' | 'reserved' | 'dispatched' | 'settled' | 'uncertain' | 'cancelled' | 'estimated';
export interface ResponseCheckpoint { status: number; statusText: string; headers: [string,string][]; body: string }
export interface LedgerAttempt {
  id:string; owner_id:string; actor_id:string; chat_id:string; request_id:string; attempt_key:string;
  source_prepared_hash:string;base_attempt_key:string;supersedes_attempt_id:string|null;tradeoffs:string|null;
  prepared_hash:string; prepared_payload:Record<string,unknown>; pricing_version:string;
  provider:string; model:string; category:string;
  preflight_estimate:Record<string,unknown>;estimator_version:string;reason:string;resolved_model:string|null; state:LedgerAttemptState;
  reserved_microusd:Microusd; actual_microusd:Microusd|null; budget_revision:number;
  usage:Record<string,unknown>|null; evidence:Record<string,unknown>|null;
  provider_receipt_id:string|null;provider_request_id:string|null;provider_response_id:string|null; response_checkpoint:ResponseCheckpoint|null;
  pause_reason:string|null;cancelled_by_owner_at:string|null; created_at:string; dispatched_at:string|null; settled_at:string|null;
}
export interface LedgerConfiguration {owner_id:string; timezone:string; per_call_limit_microusd:Microusd|null;request_limit_microusd:Microusd|null;budget_revision:number}
export interface LedgerEvent {id:string;attempt_id:string;owner_id:string;kind:string;details:Record<string,unknown>;created_at:string}
export interface LedgerSnapshot {configuration:LedgerConfiguration|null;attempts:LedgerAttempt[];events?:LedgerEvent[]}
export interface AdmitAttemptInput {
  ownerId:string;actorId:string;chatId:string;requestId:string;attemptKey:string;preparedHash:string;
  preparedPayload:Record<string,unknown>;pricingVersion:string;provider:string;model:string;
  reservedMicrousd:Microusd;category:string;preflightEstimate:unknown;estimatorVersion:string;reason:string;
}
export interface ApprovalInput {ownerId:string;attemptId:string;preparedHash:string;pricingVersion:string;budgetRevision:number;reservedMicrousd:Microusd}
export interface SettlementInput {ownerId:string;attemptId:string;provider:string;providerReceiptId:string;actualMicrousd:Microusd;usage:Record<string,unknown>;evidence:Record<string,unknown>}
