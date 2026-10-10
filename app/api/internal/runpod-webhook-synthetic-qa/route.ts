import {NextResponse} from "next/server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=30;
// Synthetic webhook callback QA. No original media; no RunPod API call.
export async function GET(){
 if(process.env.VERCEL_ENV!=="preview")return NextResponse.json({error:"preview_only"},{status:403});
 const url="https://barclcqataqyvifoeyop.supabase.co/functions/v1/katie-runpod-result-webhook?receipt=94c8f590-9bc5-4005-b19d-95a3cd1bd3b8&proof=ed9ea74a8e9c2b2e3dbe6816cc280850273f4a22278f3536415d938da44ab3c4";
 const fake={
   id:"runpod-synthetic-webhook-20261010-u1",status:"COMPLETED",delayTime:44,executionTime:12,
   input:{url:"https://private.example.test/never-store?token=SENSITIVE_TEST_TOKEN"},
   output:[{
     model:"Qwen/Qwen3-VL-8B-Instruct",
     choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:"Synthetic test: the first scene changes into the second, then ends."}}],
     usage:{prompt_tokens:17,completion_tokens:14,total_tokens:31}
   }]
 };
 const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify(fake),cache:"no-store",signal:AbortSignal.timeout(20000)});
 const body=await r.json().catch(()=>({}));
 return NextResponse.json({providerStatus:r.status,result:body},{status:r.ok?200:502});
}