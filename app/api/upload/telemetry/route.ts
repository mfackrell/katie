import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Logs only bounded transport metadata. Never log upload tickets, video bytes,
// base64 content or filenames. A failed telemetry call is nonfatal in the client.
export async function POST(request: NextRequest) {
  try {
    const rawLength = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isSafeInteger(rawLength) || rawLength > 2048) {
      return NextResponse.json({ error: "Invalid diagnostic size." }, { status: 400 });
    }
    const input = await request.json() as Record<string, unknown>;
    const stage = String(input.stage);
    if (!["prepare", "transfer", "processing", "attempt"].includes(stage)) {
      return NextResponse.json({ error: "Invalid diagnostic stage." }, { status: 400 });
    }
    const uploadId = typeof input.uploadId === "string" &&
      /^[a-f0-9-]{36}$/i.test(input.uploadId) ? input.uploadId : null;
    const chunkIndex = Number.isSafeInteger(input.chunkIndex) &&
      Number(input.chunkIndex) >= 0 && Number(input.chunkIndex) <= 499 ? Number(input.chunkIndex) : null;

    if (stage === "attempt") {
      if (!uploadId || chunkIndex === null ||
        !Number.isSafeInteger(input.attempt) || Number(input.attempt) < 1 || Number(input.attempt) > 3 ||
        !Number.isSafeInteger(input.durationMs) || Number(input.durationMs) < 0 || Number(input.durationMs) > 180_000 ||
        !Number.isSafeInteger(input.encodedBytes) || Number(input.encodedBytes) < 0 || Number(input.encodedBytes) > 3 * 1024 * 1024 ||
        !["json-base64-v2", "json-base64-v3"].includes(String(input.transport)) ||
        !["success", "timeout", "http-error", "network-error"].includes(String(input.outcome))) {
        return NextResponse.json({ error: "Invalid chunk attempt diagnostic." }, { status: 400 });
      }
      const detail = typeof input.detail === "string" ?
        input.detail.replace(/[\r\n\t]/g, " ").slice(0, 160) : null;
      const httpStatus = Number.isSafeInteger(input.httpStatus) &&
        Number(input.httpStatus) >= 100 && Number(input.httpStatus) <= 599 ? Number(input.httpStatus) : null;
      const diagnostic = {
        uploadId, chunkIndex, attempt: input.attempt, durationMs: input.durationMs,
        encodedBytes: input.encodedBytes, transport: input.transport,
        outcome: input.outcome, httpStatus, detail,
      };
      if (input.outcome === "success") console.info("[Upload Client] slow chunk attempt", diagnostic);
      else console.warn("[Upload Client] failed chunk attempt", diagnostic);
    } else {
      const failure = typeof input.error === "string" ?
        input.error.replace(/[\r\n\t]/g, " ").slice(0, 250) : "Unknown client upload error";
      const fileBytes = Number.isSafeInteger(input.fileBytes) &&
        Number(input.fileBytes) >= 0 && Number(input.fileBytes) <= 200 * 1024 * 1024 ?
        Number(input.fileBytes) : null;
      console.error("[Upload Client] video upload failure", {
        uploadId, stage, chunkIndex, fileBytes, failure,
      });
    }
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Invalid upload diagnostic." }, { status: 400 });
  }
}
