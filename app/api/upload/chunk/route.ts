import { NextRequest, NextResponse } from "next/server";
import {
  UPLOAD_JSON_CHUNK_BYTES,
  UPLOAD_JSON_SMALL_CHUNK_BYTES,
  UPLOAD_RELAY_CHUNK_BYTES,
  UploadInputError,
  uploadStoredChunk
} from "@/lib/uploads/stored-uploads";

export const runtime = "nodejs";
export const maxDuration = 120;
const MAX_JSON_BODY_BYTES = 3 * 1024 * 1024;

// Video v2 uses small first-party JSON requests, matching the successful upload
// preparation transport. The earlier binary route stays available to open tabs.
export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    const rawLength = request.headers.get("content-length");
    const declaredLength = rawLength === null ? null : Number(rawLength);
    let token: string;
    let index: number;
    let subIndex: number | undefined;
    let bytes: Uint8Array;

    if (contentType.includes("application/json")) {
      if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_JSON_BODY_BYTES)) {
        throw new UploadInputError("Video upload chunk is too large.");
      }
      const payload = await request.json() as Record<string, unknown>;
      if (
        typeof payload.uploadToken !== "string" || payload.uploadToken.length > 3000 ||
        !Number.isSafeInteger(payload.index) || Number(payload.index) < 0 ||
        typeof payload.data !== "string" ||
        payload.data.length > Math.ceil(UPLOAD_JSON_CHUNK_BYTES / 3) * 4 ||
        payload.data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data)
      ) {
        throw new UploadInputError("Invalid JSON video chunk.");
      }
      token = payload.uploadToken;
      index = Number(payload.index);
      if (Object.prototype.hasOwnProperty.call(payload, "subIndex")) {
        if (!Number.isSafeInteger(payload.subIndex) || Number(payload.subIndex) < 0 ||
            Number(payload.subIndex) > 3 ||
            payload.data.length > Math.ceil(UPLOAD_JSON_SMALL_CHUNK_BYTES / 3) * 4) {
          throw new UploadInputError("Invalid video sub-chunk.");
        }
        subIndex = Number(payload.subIndex);
      }
      const decoded = Buffer.from(payload.data, "base64");
      if (!decoded.byteLength || decoded.byteLength > UPLOAD_JSON_CHUNK_BYTES || decoded.toString("base64") !== payload.data) {
        throw new UploadInputError("Video chunk encoding is invalid.");
      }
      if (subIndex !== undefined && decoded.byteLength > UPLOAD_JSON_SMALL_CHUNK_BYTES) {
        throw new UploadInputError("Video sub-chunk exceeds 512 KiB.");
      }
      bytes = new Uint8Array(decoded);
    } else if (contentType.includes("application/octet-stream")) {
      token = request.headers.get("x-katie-upload-token") ?? "";
      const rawIndex = request.headers.get("x-katie-chunk-index") ?? "";
      if (!token || !/^(0|[1-9][0-9]*)$/.test(rawIndex)) {
        throw new UploadInputError("Invalid binary upload chunk.");
      }
      if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength > UPLOAD_RELAY_CHUNK_BYTES)) {
        throw new UploadInputError("Binary upload chunk is too large.");
      }
      bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.byteLength || bytes.byteLength > UPLOAD_RELAY_CHUNK_BYTES) {
        throw new UploadInputError("Invalid binary upload chunk length.");
      }
      index = Number(rawIndex);
    } else {
      throw new UploadInputError("Unsupported attachment chunk format.");
    }

    const result = await uploadStoredChunk(token, index, bytes, subIndex);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to upload attachment chunk.";
    console.error("[Upload API] chunk transfer failed", { message });
    return NextResponse.json({ error: message }, {
      status: error instanceof UploadInputError || error instanceof SyntaxError ? 400 : 500
    });
  }
}
