import { NextRequest, NextResponse } from "next/server";
import { getStoredUploadChunkStatus, UploadInputError } from "@/lib/uploads/stored-uploads";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    const token = body && typeof body === "object" && "uploadToken" in body
      ? (body as { uploadToken: unknown }).uploadToken : null;
    if (typeof token !== "string") throw new UploadInputError("Missing signed upload session.");
    const status = await getStoredUploadChunkStatus(token);
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cannot inspect video upload progress.";
    console.warn("[Upload API] resume status failed", { message });
    return NextResponse.json({ error: message }, {
      status: error instanceof UploadInputError || error instanceof SyntaxError ? 400 : 500
    });
  }
}
