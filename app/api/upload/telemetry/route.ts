import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Browser transport errors may happen before an API function is invoked.
// Record only bounded metadata; never accept or log source media or upload tokens.
export async function POST(request: NextRequest) {
  try {
    const rawLength = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isSafeInteger(rawLength) || rawLength > 2048) {
      return NextResponse.json({ error: "Invalid diagnostic size." }, { status: 400 });
    }
    const input = await request.json() as Record<string, unknown>;
    if (!["prepare", "transfer", "processing"].includes(String(input.stage))) {
      return NextResponse.json({ error: "Invalid diagnostic stage." }, { status: 400 });
    }
    const uploadId = typeof input.uploadId === "string" && /^[a-f0-9-]{36}$/i.test(input.uploadId) ? input.uploadId : null;
    const failure = typeof input.error === "string" ? input.error.replace(/[\r\n\t]/g, " ").slice(0, 250) : "Unknown client upload error";
    const chunkIndex = Number.isSafeInteger(input.chunkIndex) ? input.chunkIndex : null;
    const fileBytes = Number.isSafeInteger(input.fileBytes) && Number(input.fileBytes) >= 0 && Number(input.fileBytes) <= 200 * 1024 * 1024 ? input.fileBytes : null;
    console.error("[Upload Client] video upload failure", {
      uploadId, stage: input.stage, chunkIndex, fileBytes, failure
    });
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Invalid upload diagnostic." }, { status: 400 });
  }
}
