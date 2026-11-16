import { randomUUID } from "node:crypto";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { getAccountingScope } from "@/lib/standalone-accounting/context";
import { getModelPrice, priceTokenUsage, PRICING_VERSION, type AccountingProvider } from "@/lib/standalone-accounting/pricing";

/** Memory is infrastructure, not an owner-initiated paid request. Provider
 * spending is observed after the HTTP attempt, never approved/reserved/admitted
 * against a chat workflow or blocked by its lease. No prompts or replies stored.
 */
export const MEMORY_ACTIVITIES = new Set([
  "memory-summary", "memory-relevance", "memory-edit",
  "memory-maintenance", "memory-extraction",
]);
type MemoryUsage = {
  input: number; output: number; cached: number; written: number;
};
function count(v:unknown):number {
  return typeof v==="number" && Number.isSafeInteger(v) && v>=0 ? v : 0;
}
function usageFromReceipt(provider:AccountingProvider, payload:Record<string,unknown>):MemoryUsage|null {
  const u=payload.usage;
  if(!u || typeof u!=="object")return null;
  const row=u as Record<string,unknown>;
  if(provider==="anthropic") {
    const input=count(row.input_tokens),cached=count(row.cache_read_input_tokens),written=count(row.cache_creation_input_tokens);
    return {input:input+cached+written,output:count(row.output_tokens),cached,written};
  }
  const input=count(row.input_tokens??row.prompt_tokens),output=count(row.output_tokens??row.completion_tokens);
  const details=(row.input_tokens_details??row.prompt_tokens_details) as Record<string,unknown>|undefined;
  return {input,output,cached:count(details?.cached_tokens),written:0};
}
function requestModel(init?:RequestInit):string {
  if(typeof init?.body!=="string")return "unknown";
  try{
    const body=JSON.parse(init.body) as {model?:unknown};
    return typeof body.model==="string"&&body.model.length<120?body.model:"unknown";
  }catch{return "unknown";}
}
async function logMemoryCost(entry:Record<string,unknown>):Promise<void> {
  try {
    const {error}=await getSupabaseAdminClient().from("memory_provider_usage").insert(entry);
    if(error)throw Error(error.message);
  }catch(error){
    // Observability cannot veto an already authorized memory operation.
    console.error("[Memory Meter] Usage persistence failed; provider work not blocked",{
      activity:entry.activity,provider:entry.provider,requestId:entry.request_id,
      error:error instanceof Error?error.message:"unknown",
    });
  }
}
export function createMemoryMeteredFetch(
  provider:AccountingProvider,activity:string,
  policy:{timeoutMs?:number|(()=>number)}={},
  underlying:typeof fetch=fetch,
):typeof fetch {
  if(!MEMORY_ACTIVITIES.has(activity))throw Error("Memory-only transport cannot be used for user requests.");
  const host:{[P in AccountingProvider]:string}={
    anthropic:"api.anthropic.com",openai:"api.openai.com",
    grok:"api.x.ai",google:"generativelanguage.googleapis.com",
  };
  return async(input,init)=>{
    const url=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);
    if(url.protocol!=="https:" || url.hostname!==host[provider] || url.username || url.password || url.port){
      throw Error("Unexpected memory provider destination");
    }
    const scope=getAccountingScope();
    const meta=scope?.kind==="standalone"?scope.context:undefined;
    const requestId=randomUUID(),startedAt=Date.now(),model=requestModel(init);
    const duration=typeof policy.timeoutMs==="function"?policy.timeoutMs():policy.timeoutMs;
    const timeout=typeof duration==="number" && Number.isFinite(duration)?Math.max(1,Math.floor(duration)):undefined;
    const controller=timeout?new AbortController():null;
    const timer=controller?setTimeout(()=>controller.abort(),timeout):null;
    const originalSignal=init?.signal ?? (input instanceof Request?input.signal:undefined);
    const signals=[originalSignal,controller?.signal].filter((v):v is AbortSignal=>!!v);
    const signal=signals.length>1?AbortSignal.any(signals):signals[0];
    let response:Response|undefined, thrown:unknown;
    try{
      response=await underlying(input,{...init,signal});
      return response;
    }catch(error){
      thrown=error;
      throw error;
    }finally{
      if(timer)clearTimeout(timer);
      let usage:MemoryUsage|null=null;
      if(response){
        try {
          const receipt=await response.clone().json() as Record<string,unknown>;
          usage=usageFromReceipt(provider,receipt);
        }catch{/* A missing/unknown receipt cannot prevent memory processing. */}
      }
      let cost:string|null=null;
      if(usage){
        const rate=getModelPrice(provider,model);
        if(rate){
          try{cost=priceTokenUsage(rate,usage.input,usage.output,usage.cached,usage.written);}
          catch{/* Unpriced dimensions remain unknown, never fabricated. */}
        }
      }
      await logMemoryCost({
        request_id:requestId, owner_id:meta?.userId??null,
        actor_id:meta?.actorId??null,chat_id:meta?.chatId??null,
        activity,provider,model,endpoint:url.pathname,
        status:thrown?"transport_error":response?.ok?"completed":"http_error",
        http_status:response?.status??null,
        input_tokens:usage?.input??null,output_tokens:usage?.output??null,
        cached_input_tokens:usage?.cached??null,cache_write_input_tokens:usage?.written??null,
        cost_microusd:cost,pricing_version:PRICING_VERSION,
        elapsed_ms:Date.now()-startedAt,
      });
    }
  };
}
