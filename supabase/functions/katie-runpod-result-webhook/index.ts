// Source snapshot: deployed version 2. Keep callback semantics compatible.
export {};
declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };
const UUID = /^[a-f0-9]{8}-[a-f0-9-]{27,40}$/i;
const HEX = /^[a-f0-9]{64}$/i;
const JOB_ID = /^[A-Za-z0-9-]{8,150}$/;
function response(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});}
function statusMap(s:string){if(s==="COMPLETED")return "completed";if(s==="FAILED")return "failed";if(s==="CANCELLED")return "cancelled";if(s==="TIMED_OUT")return "timed_out";if(s==="IN_PROGRESS")return "in_progress";return "queued";}
async function digest(input:string){
 const bytes=new TextEncoder().encode(input);
 return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(b=>b.toString(16).padStart(2,"0")).join("");
}
// Important: RunPod webhook payload includes the original signed source URL.
// NEVER store full webhook data, echo it, or log it.
Deno.serve(async(request:Request)=>{
 if(request.method!=="POST")return response({error:"method_not_allowed"},405);
 const uri=new URL(request.url),receipt=uri.searchParams.get("receipt"),proof=uri.searchParams.get("proof");
 if(!receipt||!UUID.test(receipt)||!proof||!HEX.test(proof))return response({error:"unauthorized"},401);
 try{
  const raw=await request.text();
  if(raw.length>1000000)return response({error:"payload_too_large"},413);
  const body=JSON.parse(raw);
  if(!body||!JOB_ID.test(String(body.id||"")))return response({error:"invalid_job_id"},400);
  const url=Deno.env.get("SUPABASE_URL")||"";
  const secretRecord=Deno.env.get("SUPABASE_SECRET_KEYS");
  const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || (secretRecord?JSON.parse(secretRecord).default:undefined);
  if(!url||!key)return response({error:"storage_not_configured"},503);
  const h={"apikey":key,Authorization:"Bearer "+key,"content-type":"application/json"};
  const q=await fetch(url+"/rest/v1/video_analysis_jobs?id=eq."+encodeURIComponent(receipt)+
    "&select=id,runpod_job_id,status,error_code,callback_token_hash",{
    headers:h,signal:AbortSignal.timeout(12000)
  });
  if(!q.ok)return response({error:"job_lookup_failed"},503);
  const rows=await q.json();
  if(!Array.isArray(rows)||rows.length!==1)return response({error:"receipt_not_found"},404);
  let job=rows[0];
  const proofHash=await digest(proof);
  const state=String(body.status||"");
  const output=Array.isArray(body.output)?body.output[0]:body.output;
  const text=output?.choices?.[0]?.message?.content;
  const analysis=typeof text==="string"&&text.trim()?text.trim().slice(0,250000):null;
  const saveStatus=state==="COMPLETED"&&!analysis?"failed":statusMap(state);
  // Output contains only model-generated content and usage. No input or URLs.
  const safeOutput=output&&typeof output==="object"?{
   model: typeof output.model==="string"?output.model:null,
   choices:Array.isArray(output.choices)?output.choices.slice(0,3).map((c:Record<string,unknown>)=>({
     index:c.index,finish_reason:c.finish_reason,
     message:c.message&&typeof c.message==="object"?{
       role:(c.message as Record<string,unknown>).role,
       content:(c.message as Record<string,unknown>).content,
     }:null
   })):[],
   usage:output.usage??null
  }:null;
  const now=new Date().toISOString();
  const patch={
   runpod_job_id:body.id,status:saveStatus,analysis_text:analysis,model_output:safeOutput,
   error_code:saveStatus==="failed"?(state==="COMPLETED"?"COMPLETED_WITHOUT_ANALYSIS":"RUNPOD_"+state):null,
   queue_ms:Number.isFinite(body.delayTime)?body.delayTime:null,
   inference_ms:Number.isFinite(body.executionTime)?body.executionTime:null,
   input_tokens:Number.isFinite(output?.usage?.prompt_tokens)?output.usage.prompt_tokens:null,
   output_tokens:Number.isFinite(output?.usage?.completion_tokens)?output.usage.completion_tokens:null,
   completed_at:now,updated_at:now,last_polled_at:now,
  };
  // A registration or local deadline can race the conditional write. Revalidate
  // identity and eligibility on each retry; never acknowledge an unconfirmed save.
  for(let attempt=0;attempt<3;attempt++){
   if(!job.callback_token_hash||proofHash!==job.callback_token_hash)
     return response({error:"unauthorized"},401);
   if(job.runpod_job_id && job.runpod_job_id!==body.id)return response({error:"job_mismatch"},409);
   const localDeadline=(job.status==="timed_out" && ["SUBMISSION_ACCEPTANCE_UNRESOLVED_DEADLINE","QWEN_FIFTEEN_MINUTE_DEADLINE","QWEN_DEADLINE_POLL_UNAVAILABLE"].includes(job.error_code)) ||
     (job.status==="expired" && job.error_code==="RUNPOD_RESULT_EXPIRED_OR_NOT_FOUND");
   if(!localDeadline && !["pending","queued","in_progress"].includes(job.status))return response({status:job.status,saved:true,already_terminal:true});
   if(!["COMPLETED","FAILED","CANCELLED","TIMED_OUT"].includes(state))
     return response({error:"not_terminal"},409);
   const saved=await fetch(url+"/rest/v1/video_analysis_jobs?id=eq."+encodeURIComponent(receipt)+"&status=eq."+encodeURIComponent(job.status)+
     (localDeadline?"&error_code=eq."+encodeURIComponent(job.error_code):"")+
     (job.runpod_job_id?"&runpod_job_id=eq."+encodeURIComponent(job.runpod_job_id):"&runpod_job_id=is.null"),{
    method:"PATCH",headers:{...h,Prefer:"return=representation"},
    body:JSON.stringify(patch),signal:AbortSignal.timeout(12000)
   });
   if(!saved.ok)return response({error:"persistence_failed"},503);
   const confirm=await saved.json();
   if(!Array.isArray(confirm))return response({error:"missing_save_confirmation"},503);
   if(confirm.length===1)return response({status:saveStatus,saved:true});
   if(confirm.length!==0)return response({error:"missing_save_confirmation"},503);
   const refreshed=await fetch(url+"/rest/v1/video_analysis_jobs?id=eq."+encodeURIComponent(receipt)+
     "&select=id,runpod_job_id,status,error_code,callback_token_hash",{
     headers:h,signal:AbortSignal.timeout(12000)
   });
   if(!refreshed.ok)return response({error:"job_lookup_failed"},503);
   const current=await refreshed.json();
   if(!Array.isArray(current)||current.length!==1)return response({error:"receipt_not_found"},404);
   job=current[0];
  }
  return response({error:"persistence_conflict"},503);
 }catch(err){return response({error:err instanceof SyntaxError?"invalid_payload":"capture_failed"},503);}
});
