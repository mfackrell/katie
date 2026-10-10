import {NextRequest, NextResponse} from "next/server";
import {assertRunpodAdmin, submitSavedVideo} from "@/lib/runpod/durable-results";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

export async function POST(request: NextRequest) {
  if(!assertRunpodAdmin(request)) return NextResponse.json({error:"unauthorized"}, {status:401});
  try {
    const payload: unknown = await request.json();
    if(!payload || typeof payload !== "object") {
      return NextResponse.json({error:"invalid_payload"}, {status:400});
    }
    const obj=payload as Record<string,unknown>;
    if(typeof obj.chatId!=="string"||typeof obj.attachmentPath!=="string"||typeof obj.question!=="string") {
      return NextResponse.json({error:"missing_fields"}, {status:400});
    }
    const result=await submitSavedVideo({
      chatId:obj.chatId, attachmentPath:obj.attachmentPath, question:obj.question
    });
    return NextResponse.json(result, {status:202,headers:{"cache-control":"no-store"}});
  } catch(err) {
    // Do not expose private signed URLs or provider exception messages.
    const problem=err instanceof Error && /Invalid chat ID|question must/i.test(err.message)
      ? "invalid_video_request" : "submission_failed";
    return NextResponse.json({error:problem},{status:problem==="invalid_video_request"?400:502});
  }
}