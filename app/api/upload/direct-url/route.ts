import { NextRequest, NextResponse } from "next/server";
import { signStoredUploadChunks, UploadInputError } from "@/lib/uploads/stored-uploads";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(request: NextRequest) {
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > 4000) throw new UploadInputError("Invalid direct upload request size.");
    const raw: unknown = await request.json();
    if (!raw || typeof raw !== "object") throw new UploadInputError("Missing upload session.");
    const value = raw as { uploadToken?: unknown; entries?: unknown };
    if (typeof value.uploadToken !== "string" ||
        !Array.isArray(value.entries) || value.entries.length > 50) {
      throw new UploadInputError("Invalid signed direct video upload request.");
    }
    const entries = value.entries.map(entry => {
      if (!entry || typeof entry !== "object") throw new UploadInputError("Invalid video chunk.");
      const payload = entry as { index?: unknown; subIndex?: unknown };
      return { index: payload.index, ...(payload.subIndex === undefined ? {} : { subIndex: payload.subIndex }) };
    }) as Array<{ index: number; subIndex?: number }>;
    return NextResponse.json(await signStoredUploadChunks(value.uploadToken, entries), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to sign private upload chunks.";
    console.warn("[Upload API] direct upload signing failed", { message });
    return NextResponse.json({ error: message }, {
      status: error instanceof UploadInputError || error instanceof SyntaxError ? 400 : 500,
    });
  }
}
