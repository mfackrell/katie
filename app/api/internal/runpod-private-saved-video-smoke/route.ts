import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 50;

// Temporary, preview-only, SSO-protected test harness. Does not modify chat,
// upload persistence, router behavior, or production application.
const ENDPOINT = "yafwsm98e8m9lv";
const PROJECT_URL = "https://barclcqataqyvifoeyop.supabase.co";
const EDGE_FUNCTION = "katie-runpod-private-video-test-20261010";

export async function GET(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview") {
    return NextResponse.json({error:"preview_only"}, {status:403});
  }
  const apiKey = process.env.RUNPOD_API_KEY;
  if (!apiKey || apiKey.length < 16) {
    return NextResponse.json({error:"runpod_key_unavailable"}, {status:503});
  }
  const action = request.nextUrl.searchParams.get("action");
  try {
    if (action === "submit") {
      const resp = await fetch(PROJECT_URL + "/functions/v1/" + EDGE_FUNCTION, {
        method:"POST", cache:"no-store",
        headers: {Authorization: "Bearer " + apiKey, "content-type": "application/json"},
        body:JSON.stringify({operation:"submit_one_existing_video"}),
        signal: AbortSignal.timeout(40000)
      });
      const data: unknown = await resp.json().catch(()=>({}));
      // Edge function never returns private URLs, storage secrets, or video bytes.
      return NextResponse.json({httpStatus:resp.status, result:data}, {status:resp.ok?200:502});
    }
    if (action === "status") {
      const jobId=request.nextUrl.searchParams.get("jobId")??"";
      if (!/^[A-Za-z0-9_-]{4,120}$/.test(jobId)) {
        return NextResponse.json({error:"invalid_job_id"}, {status:400});
      }
      const resp=await fetch("https://api.runpod.ai/v2/"+ENDPOINT+"/status/"+jobId,{
        headers: {Authorization:"Bearer "+apiKey}, cache:"no-store",
        signal: AbortSignal.timeout(30000)
      });
      const data=await resp.json().catch(()=>({}));
      const first=Array.isArray(data.output) ? data.output[0] : data.output;
      const responseText=first?.choices?.[0]?.message?.content;
      return NextResponse.json({
        httpStatus:resp.status, jobId:data.id,status:data.status,
        delayMs:data.delayTime??null, executionMs:data.executionTime??null,
        model:first?.model??null,
        inputTokenCount:first?.usage?.prompt_tokens??null,
        outputTokenCount:first?.usage?.completion_tokens??null,
        analysis:typeof responseText==="string"?responseText.slice(0,6000):null,
        innerError:first?.error ? String(first.error).slice(0,250):null,
        failure:data.status==="FAILED"?String(data.error??"worker_failed").slice(0,250):null,
      },{status:resp.ok?200:502});
    }
    return NextResponse.json({error:"unknown_action"}, {status:400});
  } catch (error) {
    return NextResponse.json({error:error instanceof Error?error.name:"transport_failure"}, {status:502});
  }
}