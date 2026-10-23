import { after, NextRequest, NextResponse } from "next/server";
import { assertCronAuth } from "@/lib/runpod/durable-results";
import { processReactionReply } from "@/lib/chat/reaction-reply-worker";
export const runtime="nodejs";
export const maxDuration=300;
export async function GET(req:NextRequest) {
 if(!assertCronAuth(req))return NextResponse.json({error:"unauthorized"},{status:401});
 const results=[];
 for(let i=0;i<2;i++){
   const result=await processReactionReply(undefined,req.nextUrl.origin);
   results.push(result);
   if(result.status==="empty")break;
 }
 return NextResponse.json({results});
}
export async function POST(req:NextRequest) {
 if(!assertCronAuth(req))return NextResponse.json({error:"unauthorized"},{status:401});
 const parsed=await req.json().catch(()=>null) as {jobId?:number}|null;
 if(!Number.isSafeInteger(parsed?.jobId))return NextResponse.json({error:"Invalid job"},{status:400});
 after(async()=>{await processReactionReply(parsed!.jobId,req.nextUrl.origin);});
 return NextResponse.json({accepted:true},{status:202});
}
