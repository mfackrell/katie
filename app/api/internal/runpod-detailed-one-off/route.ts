import {NextResponse} from "next/server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=50;
export async function GET(){
 if(process.env.VERCEL_ENV!=="preview")return NextResponse.json({error:"preview_only"},{status:403});
 const key=process.env.RUNPOD_API_KEY;
 if(!key)return NextResponse.json({error:"missing_runpod_key"},{status:503});
 try{
  const result=await fetch("https://barclcqataqyvifoeyop.supabase.co/functions/v1/katie-runpod-detailed-video-qa-20261010",{
   method:"POST",headers:{Authorization:"Bearer "+key,"content-type":"application/json"},
   body:JSON.stringify({run:"detailed_native_video"}),cache:"no-store",signal:AbortSignal.timeout(42000)
  });
  const body=await result.json().catch(()=>({}));
  return NextResponse.json({upstreamStatus:result.status,result:body},{status:result.ok?200:502,
    headers:{"cache-control":"no-store"}});
 }catch(error){return NextResponse.json({error:error instanceof Error?error.name:"transport_error"},{status:502});}
}