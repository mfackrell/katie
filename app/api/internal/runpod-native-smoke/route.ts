import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 55;
const ENDPOINT_ID = "yafwsm98e8m9lv";
const MODEL = "Qwen/Qwen3-VL-8B-Instruct";
const TEST_VIDEO = "https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen2-VL/space_woaudio.mp4";

export async function GET(req:NextRequest) {
  if (process.env.VERCEL_ENV!=="preview")return NextResponse.json({error:"preview_only"},{status:403});
  const key=process.env.RUNPOD_API_KEY;
  if(!key)return NextResponse.json({error:"missing_runpod_key"},{status:503});
  const mode=req.nextUrl.searchParams.get("action") ?? "health";
  const headers={Authorization:`Bearer ${key}`,"Content-Type":"application/json"};
  try {
    if(mode==="health") {
      const res=await fetch(`https://api.runpod.io/v2/serverless/${ENDPOINT_ID}`,{headers,cache:"no-store",signal:AbortSignal.timeout(20000)});
      const body=await res.json().catch(()=>({}));
      return NextResponse.json({action:mode,httpStatus:res.status,id:body.id,name:body.name,workers:body.workers,gpu:body.gpu,status:body.status,type:body.type});
    }
    if(mode==="worker_health") {
      const res=await fetch(`https://api.runpod.ai/v2/${ENDPOINT_ID}/health`,{
        headers,cache:"no-store",signal:AbortSignal.timeout(25000)
      });
      const body=await res.json().catch(()=>({}));
      return NextResponse.json({action:mode,httpStatus:res.status,
        jobs:body.jobs,workers:body.workers,status:body.status,
        errorCode:res.ok?null:"health_api_unavailable"});
    }
    if(mode==="start") {
      const res=await fetch(`https://api.runpod.ai/v2/${ENDPOINT_ID}/run`,{
        method:"POST",headers,cache:"no-store",signal:AbortSignal.timeout(30000),
        body:JSON.stringify({
          input:{
            route:"/v1/chat/completions",
            method:"POST",
            body:{
              model:MODEL,
              messages:[{role:"user",content:[
                {type:"video_url",video_url:{url:TEST_VIDEO}},
                {type:"text",text:"Analyze the video in temporal order. What movements and events occur? Mention visible scene transitions. Answer in three sentences."}
              ]}],
              temperature:0,
              max_tokens:230
            }
          }
        })
      });
      const body=await res.json().catch(()=>({}));
      return NextResponse.json({action:mode,httpStatus:res.status,jobId:body.id,status:body.status,errorCode:body.errorCode ?? null});
    }
    if(mode==="status") {
      const job=req.nextUrl.searchParams.get("jobId")??"";
      if(!/^[A-Za-z0-9_-]{4,110}$/.test(job))
        return NextResponse.json({error:"invalid_job_id"},{status:400});
      const res=await fetch(`https://api.runpod.ai/v2/${ENDPOINT_ID}/status/${job}`,{headers,cache:"no-store",signal:AbortSignal.timeout(30000)});
      const body=await res.json().catch(()=>({}));
      const output=body.output;
      const content=output?.choices?.[0]?.message?.content ?? output?.output?.choices?.[0]?.message?.content ?? output?.text ?? null;
      return NextResponse.json({
        action:mode,httpStatus:res.status,jobId:body.id,status:body.status,
        delayMs:body.delayTime??null,executionMs:body.executionTime??null,
        model:output?.model??null,
        content:typeof content==="string"?content.slice(0,3500):null,
        workerError:body.status==="FAILED"?String(body.error ?? output?.error ?? "unknown_worker_error").slice(0,300):null,
        outputKeys:output&&typeof output==="object"?Object.keys(output):[],
        outputPreview:body.status==="COMPLETED"?JSON.stringify(output).slice(0,4500):null
      });
    }
    return NextResponse.json({error:"unsupported_action"},{status:400});
  }catch(e){return NextResponse.json({error:e instanceof Error?e.name:"transport_error"},{status:502});}
}
