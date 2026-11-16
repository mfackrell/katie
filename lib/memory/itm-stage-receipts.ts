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
