import {NextRequest, NextResponse} from "next/server";
import {assertRunpodAdmin,resultStore} from "@/lib/runpod/durable-results";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:NextRequest){
  if(!assertRunpodAdmin(request))return NextResponse.json({error:"unauthorized"},{status:401});
  const id=request.nextUrl.searchParams.get("id");
  if(!id||! /^[0-9a-f-]{36}$/i.test(id))return NextResponse.json({error:"invalid_id"},{status:400});
  try{
    const {data,error}=await resultStore().from("video_analysis_jobs")
      .select("id,runpod_job_id,chat_id,attachment_path,model,status,analysis_text,model_output,error_code,queue_ms,inference_ms,input_tokens,output_tokens,submitted_at,completed_at")
      .eq("id",id).maybeSingle();
    if(error)return NextResponse.json({error:"read_failed"},{status:503});
    if(!data)return NextResponse.json({error:"not_found"},{status:404});
    return NextResponse.json({result:data},{headers:{"cache-control":"private, no-store"}});
  }catch{return NextResponse.json({error:"storage_unavailable"},{status:503});}
}