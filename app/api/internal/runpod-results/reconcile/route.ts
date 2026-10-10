import {NextRequest, NextResponse} from "next/server";
import {
  ACTIVE_RUNPOD_STATES, assertCronAuth, refreshRunpodJob, resultStore
} from "@/lib/runpod/durable-results";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=120;

// Vercel Cron runs once per minute; recover webhook delivery failures before
// RunPod's 30-minute completed-result retention window expires.
export async function GET(request:NextRequest){
  if(!assertCronAuth(request))return NextResponse.json({error:"unauthorized"},{status:401});
  try{
    const client=resultStore();
    const {data,error}=await client.from("video_analysis_jobs")
      .select("id,runpod_job_id,endpoint_id,status,submitted_at")
      .in("status",[...ACTIVE_RUNPOD_STATES])
      .order("submitted_at",{ascending:true}).limit(30);
    if(error)throw new Error("reconciliation database read failed");
    const rows=(data ?? []) as Array<{id:string;runpod_job_id:string|null;endpoint_id:string;status:string;submitted_at:string}>;
    let checked=0,saved=0,failed=0;
    for(const row of rows){
      if(!row.runpod_job_id){
        if(Date.now()-new Date(row.submitted_at).getTime()>120000){
          const {error:staleError}=await client.from("video_analysis_jobs").update({
            status:"failed",error_code:"UNREGISTERED_SUBMISSION_TIMED_OUT",
            completed_at:new Date().toISOString(),updated_at:new Date().toISOString()
          }).eq("id",row.id).eq("status","pending");
          if(staleError)failed++;
        }
        continue;
      }
      checked++;
      try{
        const result=await refreshRunpodJob(client,row);
        if(result.saved)saved++;
      }catch{
        failed++;
        // A failed poll is not a failed video; next cron invocation retries it.
      }
    }
    return NextResponse.json({checked,saved,failed,remaining:rows.length},{
      headers:{"cache-control":"no-store"}
    });
  }catch{
    return NextResponse.json({error:"reconciliation_failed"},{status:503});
  }
}