import {createHash} from "node:crypto";
import {getSupabaseAdminClient} from "@/lib/data/supabase/admin";

export type ItmStage = "episodes" | "retention";
export type ItmReceiptKey = {
  actorId:string; chatId:string; batchEndMessageId:string;
  expectedCursor:string|null; provider:"grok"|"anthropic";
  sourceSha256:string; contextSha256:string; stage:ItmStage;
};
export type ItmStoredReceipt = {responseText:string;responseSha256:string};
export const itmReceiptHash=(value:string):string=>
  createHash("sha256").update(value,"utf8").digest("hex");

/** Read only already-persisted evidence; no provider calls or spend. */
export async function readItmStageReceipt(key:ItmReceiptKey):Promise<ItmStoredReceipt|null>{
  const admin=getSupabaseAdminClient();
  const {data,error}=await admin.from("itm_stage_receipts")
    .select("response_text,response_sha256,expected_cursor")
    .eq("actor_id",key.actorId).eq("chat_id",key.chatId)
    .eq("batch_end_message_id",key.batchEndMessageId)
    .eq("provider",key.provider).eq("stage",key.stage)
    .eq("source_sha256",key.sourceSha256).eq("context_sha256",key.contextSha256)
    .maybeSingle<{response_text:string;response_sha256:string;expected_cursor:string|null}>();
  if(error)throw new Error("ITM_RECEIPT_READ_UNAVAILABLE");
  if(!data)return null;
  if(data.expected_cursor!==key.expectedCursor)
    throw new Error("ITM_RECEIPT_CURSOR_MISMATCH");
  if(typeof data.response_text!=="string"||data.response_text.length<1||data.response_text.length>16000||
    itmReceiptHash(data.response_text)!==data.response_sha256)
    throw new Error("ITM_RECEIPT_INTEGRITY_FAILED");
  return {responseText:data.response_text,responseSha256:data.response_sha256};
}

/** Persist a completed provider stage before content validation; a rejected
 * format is still paid evidence and must not be silently re-transmitted.
 * Write conflicts are acceptable ONLY if the prior bytes match identically.
 */
export async function recordItmStageReceipt(
  key:ItmReceiptKey,responseText:string,processorVersion:string,
):Promise<ItmStoredReceipt>{
  if(typeof responseText!=="string"||responseText.length<1||responseText.length>16000)
    throw new Error("ITM_RECEIPT_OUTPUT_BOUNDS");
  const responseSha256=itmReceiptHash(responseText);
  const admin=getSupabaseAdminClient();
  const {error}=await admin.from("itm_stage_receipts").insert({
    actor_id:key.actorId,chat_id:key.chatId,batch_end_message_id:key.batchEndMessageId,
    expected_cursor:key.expectedCursor,provider:key.provider,stage:key.stage,
    source_sha256:key.sourceSha256,context_sha256:key.contextSha256,
    response_sha256:responseSha256,response_text:responseText,
    processor_version:processorVersion,
  });
  if(error){
    const saved=await readItmStageReceipt(key);
    if(!saved || saved.responseSha256!==responseSha256)
      throw new Error("ITM_RECEIPT_WRITE_UNAVAILABLE_OR_CONFLICT");
    return saved;
  }
  return {responseText,responseSha256};
}

/** Historical server-authoritative claims supplement legacy provider receipts.
 * v13 dispatches were outside the old paid ledger and MUST be fenced even
 * though the original response body was never stored. Conservative denial
 * is safer than an unauthorized duplicate inference.
 */
export async function inspectPriorItmClaims(
  actorId:string,chatId:string,batchEndMessageId:string,
):Promise<{grok:boolean;anthropic:boolean}>{
  const {data,error}=await getSupabaseAdminClient().from("intermediate_memory_batch_attempts")
    .select("processor_version,state")
    .eq("actor_id",actorId).eq("chat_id",chatId)
    .eq("batch_end_message_id",batchEndMessageId)
    .returns<{processor_version:string;state:string}>();
  if(error)throw new Error("ITM_PRIOR_CLAIM_INSPECTION_UNAVAILABLE");
  const rows=data??[];
  // No assumptions that blocked means unbilled. Both incomplete and settled
  // claims fence the corresponding provider unless an exact saved receipt
  // can be replayed without dispatch.
  return {
    grok:rows.some(a=>a.processor_version.endsWith(":grok")),
    anthropic:rows.some(a=>a.processor_version.endsWith(":anthropic")),
  };
}

/** Read a source-bound pre-v14 paid response without transmitting to a model.
 * The caller must independently validate every citation against its exact
 * current 30-message batch before accepting or persisting the output. */
export async function readLegacyItmEpisodeOutput(
  actorId:string,chatId:string,batchEndMessageId:string,
  provider:"grok"|"anthropic",
):Promise<{responseText:string;ledgerAttemptId:string}|null>{
  const {data,error}=await getSupabaseAdminClient().rpc<{
    response_text:string|null;ledger_attempt_id:string|null;
  }|null>("itm_read_legacy_episode_output",{
    p_actor_id:actorId,p_chat_id:chatId,
    p_batch_end_message_id:batchEndMessageId,p_provider:provider,
  });
  if(error)throw new Error("ITM_LEGACY_RECEIPT_LOOKUP_UNAVAILABLE");
  if(!data)return null;
  if(typeof data.response_text!=="string"||data.response_text.length<1||
    data.response_text.length>16000||
    typeof data.ledger_attempt_id!=="string")
    throw new Error("ITM_LEGACY_RECEIPT_MALFORMED");
  return {responseText:data.response_text,ledgerAttemptId:data.ledger_attempt_id};
}
