import { NextRequest, NextResponse } from "next/server";
import { UPLOAD_RELAY_CHUNK_BYTES, UploadInputError, uploadStoredChunk } from "@/lib/uploads/stored-uploads";

export const runtime = "nodejs";
export const maxDuration = 120;

// This endpoint only receives small, signed binary chunks on Katie's own origin.
// A service-role key is used server-side; it is never returned to the browser.
export async function POST(request: NextRequest) {
  try {
    const token = request.headers.get("x-katie-upload-token");
    const rawIndex = request.headers.get("x-katie-chunk-index");
    if (!token || !rawIndex || !/^(0|[1-9][0-9]*)$/.test(rawIndex)) {
      throw new UploadInputError("Missing or invalid attachment chunk credentials.");
    }
    const contentLength = request.headers.get("content-length");
    if (contentLength && (!Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > UPLOAD_RELAY_CHUNK_BYTES)) {
      throw new UploadInputError("Attachment chunk exceeds the maximum size.");
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > UPLOAD_RELAY_CHUNK_BYTES) {
      throw new UploadInputError("Attachment chunk is empty or exceeds the maximum size.");
    }
    const result = await uploadStoredChunk(token, Number(rawIndex), bytes);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to upload attachment chunk.";
    console.error("[Upload API] chunk transfer failed", { message });
    return NextResponse.json({ error: message }, { status: error instanceof UploadInputError ? 400 : 500 });
  }
}
