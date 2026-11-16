import {NextRequest,NextResponse} from "next/server";
import {assertCronAuth} from "@/lib/runpod/durable-results";
import {getSupabaseAdminClient} from "@/lib/data/supabase/admin";
import {maybeUpdateSummary} from "@/lib/memory/summarizer";
import {runWithStandaloneAccounting} from "@/lib/standalone-accounting/context";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=180;
const CHAT="6e6a5c19-b747-4974-9dc7-890dacd13e03";
const END="f936a6e5-e7ed-5454-a914-bd6ce862924e";
const CURSOR="9fcca5dc-b304-5ea5-a118-0e2d0b645621";
const SOURCE_SHA="0d29ffce148463eb1f9bdc945901476b77b84402c2bcae6491de9058c65b2eb9";

// Vercel's CRON_SECRET is mandatory; no public or conversational dispatch.
// A pending exact-batch one-shot grant is required before touching memory.
export async function GET(request:NextRequest){
  if(!assertCronAuth(request))return NextResponse.json({error:"unauthorized"},{status:401});
  try{
    const admin=getSupabaseAdminClient();
    const {data:grant,error:grantError}=await admin.from("itm_stage2_one_shot_grants")
      .select("actor_id,expected_cursor,source_sha256,dispatched_at")
      .eq("chat_id",CHAT).eq("batch_end_message_id",END)
      .maybeSingle<{
        actor_id:string;expected_cursor:string;source_sha256:string;dispatched_at:string|null;
      }>();
    if(grantError)throw new Error("ITM_ONE_SHOT_GRANT_READ_UNAVAILABLE");
    if(!grant)return NextResponse.json({status:"no_pending_grant"});
    if(grant.expected_cursor!==CURSOR||grant.source_sha256!==SOURCE_SHA)
      return NextResponse.json({status:"grant_source_mismatch"},{status:409});
    // Once claimed, only immutable VALID retention evidence permits offline
    // checkpoint CAS recovery. Never recontact Claude on an uncertain result.
    if(grant.dispatched_at!==null){
      const {data:receipts,error:receiptError}=await admin.from("itm_stage_receipts")
        .select("processor_version").eq("actor_id",grant.actor_id).eq("chat_id",CHAT)
        .eq("batch_end_message_id",END).eq("source_sha256",SOURCE_SHA)
        .eq("provider","anthropic").eq("stage","retention").limit(10)
        .returns<{processor_version:string}>();
      if(receiptError)throw new Error("ITM_ONE_SHOT_RECEIPT_READ_UNAVAILABLE");
      if(!(receipts??[]).some(row=>!row.processor_version.endsWith(":incomplete")))
        return NextResponse.json({status:"grant_consumed_no_valid_receipt"});
    }
    const {data:state,error:stateError}=await admin.from("intermediate_memory")
      .select("content").eq("actor_id",grant.actor_id).eq("chat_id",CHAT)
      .maybeSingle<{content:{sourceMessageCount?:number;summarizedThroughMessageId?:string}}>();
    if(stateError)throw new Error("ITM_ONE_SHOT_CHECKPOINT_READ_UNAVAILABLE");
    if(!state||state.content.sourceMessageCount!==928||
      state.content.summarizedThroughMessageId!==CURSOR)
      return NextResponse.json({status:"checkpoint_not_928"});
    // Bind memory usage to the original authenticated owner/actor/chat.
    // This scope is for telemetry ONLY; memory-summary transport bypasses
    // standalone workflow and request budget admission entirely.
    const {data:usage,error:usageError}=await admin.from("memory_provider_usage")
      .select("owner_id").eq("actor_id",grant.actor_id).eq("chat_id",CHAT)
      .order("created_at",{ascending:false}).limit(1)
      .returns<{owner_id:string|null}>();
    if(usageError||!usage?.[0]?.owner_id)
      throw new Error("ITM_ONE_SHOT_OWNER_PROVENANCE_UNAVAILABLE");
    const result=await runWithStandaloneAccounting({
      userId:usage[0].owner_id,actorId:grant.actor_id,chatId:CHAT,
      requestId:"itm-approved-stage2-"+END,
    },()=>maybeUpdateSummary(CHAT));
    return NextResponse.json({status:result},{headers:{"cache-control":"no-store"}});
  }catch(error){
    console.error("[ITM One-shot] Protected recovery failed",error instanceof Error?error.message:"unavailable");
    return NextResponse.json({error:"recovery_unavailable"},{status:503});
  }
}
