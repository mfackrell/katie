import { after, NextRequest, NextResponse } from "next/server";
import { beginStoredUploadProcessing, completeStoredUpload, processStoredUploadInBackground, UploadInputError } from "@/lib/uploads/stored-uploads";

export const runtime = "nodejs";
export const maxDuration = 800;
export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    if (typeof payload?.uploadToken !== "string") throw new UploadInputError("Missing attachment upload reference.");
    if (payload.background === true) {
      const job = await beginStoredUploadProcessing(payload.uploadToken);
      if (job.scheduled) {
        after(() => processStoredUploadInBackground(payload.uploadToken));
      }
      console.info("[Upload API] finalization acknowledged", {
        status: job.status, scheduled: job.scheduled
      });
      return NextResponse.json(job.status === "ready" ?
        { status: "ready", fileReference: job.fileReference } :
        { status: "processing", startedAt: job.startedAt }, {
          status: job.status === "ready" ? 200 : 202,
          headers: { "Cache-Control": "no-store" }
        });
    }
    // Old tabs and non-video file uploads still receive a normal response.
    const fileReference = await completeStoredUpload(payload.uploadToken, payload.videoFrames);
    return NextResponse.json({ fileReference }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to process attachment.";
    console.error("[Upload API] processing failed", { message });
    return NextResponse.json({ error: message }, { status: error instanceof UploadInputError || error instanceof SyntaxError ? 400 : 500 });
  }
}
