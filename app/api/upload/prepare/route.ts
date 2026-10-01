import { NextRequest, NextResponse } from "next/server";
import { prepareStoredUpload, UploadInputError } from "@/lib/uploads/stored-uploads";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const result = await prepareStoredUpload(await request.json());
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to prepare attachment upload.";
    return NextResponse.json({ error: message }, { status: error instanceof UploadInputError || error instanceof SyntaxError ? 400 : 500 });
  }
}
