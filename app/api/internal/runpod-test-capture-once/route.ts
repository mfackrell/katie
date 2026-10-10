import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 40;
export async function GET() {
  if(process.env.VERCEL_ENV!=="preview") return NextResponse.json({error:"preview_only"},{status:403});
  const key=process.env.RUNPOD_API_KEY;
  if(!key) return NextResponse.json({error:"runpod_credential_missing"},{status:503});
  try{
    const r=await fetch("https://barclcqataqyvifoeyop.supabase.co/functions/v1/katie-runpod-result-capture",{
      method:"POST",
      headers:{Authorization:"Bearer "+key,"content-type":"application/json"},
      body:JSON.stringify({job_id:"26a0652c-a089-4dd7-9699-140927ca3791-u2"}),
      cache:"no-store",signal:AbortSignal.timeout(32000),
    });
    const output=await r.json().catch(()=>({}));
    return NextResponse.json({httpStatus:r.status,result:output},{status:r.ok?200:502});
  }catch(e){return NextResponse.json({error:e instanceof Error?e.name:"transport_failure"},{status:502});}
}