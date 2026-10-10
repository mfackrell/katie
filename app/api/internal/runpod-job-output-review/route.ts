import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 25;
const ENDPOINT = "yafwsm98e8m9lv";
export async function GET(req: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview") {
    return NextResponse.json({error:"preview_only"},{status:403});
  }
  const key=process.env.RUNPOD_API_KEY;
  if(!key) return NextResponse.json({error:"key_not_configured"},{status:503});
  const job=req.nextUrl.searchParams.get("jobId")??"";
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27,40}-[a-z0-9]{1,8}$/.test(job))
    return NextResponse.json({error:"invalid_job_id"},{status:400});
  const response=await fetch(
    "https://api.runpod.ai/v2/"+ENDPOINT+"/status/"+job,
    {headers:{"Authorization":"Bearer "+key},cache:"no-store",signal:AbortSignal.timeout(15000)}
  );
  const data=await response.json().catch(()=>({}));
  const output=Array.isArray(data.output)?data.output[0]:data.output;
  const content=output?.choices?.[0]?.message?.content;
  const mode=req.nextUrl.searchParams.get("mode");
  const result={
    job: job,status:data.status,code:response.status,
    model:output?.model??null,
    tokens:output?.usage?.completion_tokens??null,
    textReceived:typeof content==="string",
    textLength:typeof content==="string"?content.length:0,
    finishReason:output?.choices?.[0]?.finish_reason??null,
  };
  if(mode==="output" && typeof content==="string"){
    return new NextResponse(content,{
      status:200, headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}
    });
  }
  return NextResponse.json(result);
}