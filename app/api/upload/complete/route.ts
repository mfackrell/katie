import { NextRequest, NextResponse } from "next/server";
import { completeStoredUpload, UploadInputError } from "@/lib/uploads/stored-uploads";

export const runtime = "nodejs";
export const maxDuration = 800;
export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    if (typeof payload?.uploadToken !== "string") throw new UploadInputError("Missing attachment upload reference.");
    const fileReference = await completeStoredUpload(payload.uploadToken);
    return NextResponse.json({ fileReference }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to process attachment.";
    console.error("[Upload API] processing failed", { message });
    return NextResponse.json({ error: message }, { status: error instanceof UploadInputError || error instanceof SyntaxError ? 400 : 500 });
  }
}
