import type { FileReference } from "@/lib/providers/types";

const JSON_VIDEO_CHUNK_BYTES = 2 * 1024 * 1024;

async function readUploadResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch { /* Hosting errors can be HTML or plain text. */ }
  if (!response.ok) {
    if (response.status === 413) throw new Error("The upload request exceeded the server's size limit.");
    const message = typeof payload.error === "string" ? payload.error : typeof payload.message === "string" ? payload.message : undefined;
    throw new Error(message ?? `Attachment upload failed (HTTP ${response.status}).`);
  }
  return payload;
}

// A 2 MB slice becomes a ~2.8 MB JSON body, safely under Vercel's request limit.
// FileReader is the established iOS Blob reader; arrayBuffer is a fallback and
// keeps Node's browser-side tests independent of browser globals.
async function videoSliceAsBase64(slice: Blob): Promise<string> {
  if (typeof FileReader !== "undefined") {
    try {
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("Could not read video part."));
        reader.onload = () => {
          const value = reader.result;
          if (typeof value !== "string" || !value.includes(",")) {
            reject(new Error("Could not encode video part."));
            return;
          }
          resolve(value.slice(value.indexOf(",") + 1));
        };
        reader.readAsDataURL(slice);
      });
    } catch { /* Fall back to Blob.arrayBuffer for this individual part. */ }
  }
  const bytes = new Uint8Array(await slice.arrayBuffer());
  const blocks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    blocks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(blocks.join(""));
}

// No filename, upload bytes, signed URL, or token are sent in diagnostics.
// This records browser-only failures previously missing from Vercel logs.
async function reportVideoUploadError(
  fetcher: typeof fetch,
  params: { uploadId?: string; stage: string; message: string; chunkIndex?: number; fileBytes: number },
): Promise<void> {
  try {
    await fetcher("/api/upload/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uploadId: params.uploadId,
        stage: params.stage,
        error: params.message.slice(0, 250),
        chunkIndex: params.chunkIndex,
        fileBytes: params.fileBytes,
      }),
      keepalive: true,
    });
  } catch { /* Diagnostics must never mask the original upload failure. */ }
}

export async function uploadFilesDirect(
  files: File[], onStatus: (message: string) => void = () => {}, fetcher: typeof fetch = fetch,
): Promise<FileReference[]> {
  if (files.length > 5) throw new Error("Too many files. Maximum allowed is 5.");
  const references: FileReference[] = [];
  for (const file of files) {
    const isVideo = file.type.startsWith("video/");
    let stage = "prepare";
    let uploadId: string | undefined;
    let chunkIndex: number | undefined;
    try {
      onStatus(`Preparing ${file.name}…`);
      const prepared = await readUploadResponse(await fetcher("/api/upload/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          type: file.type,
          size: file.size,
          ...(isVideo ? { transport: "json-base64-v2" } : {}),
        }),
      }));
      if (typeof prepared.uploadUrl !== "string" || typeof prepared.uploadToken !== "string") {
        throw new Error("Unable to prepare attachment upload.");
      }
      uploadId = typeof prepared.uploadId === "string" ? prepared.uploadId : undefined;
      stage = "transfer";
      if (isVideo) {
        const chunkCount = Math.ceil(file.size / JSON_VIDEO_CHUNK_BYTES);
        for (let index = 0; index < chunkCount; index++) {
          chunkIndex = index;
          const offset = index * JSON_VIDEO_CHUNK_BYTES;
          const slice = file.slice(offset, Math.min(offset + JSON_VIDEO_CHUNK_BYTES, file.size));
          let uploaded = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const data = await videoSliceAsBase64(slice);
              const response = await fetcher("/api/upload/chunk", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ uploadToken: prepared.uploadToken, index, data }),
              });
              await readUploadResponse(response);
              uploaded = true;
              break;
            } catch (error) {
              if (attempt === 3) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`Video upload failed at part ${index + 1}/${chunkCount}: ${detail}`);
              }
              onStatus(`Retrying ${file.name}: part ${index + 1}/${chunkCount}…`);
              await new Promise(resolve => setTimeout(resolve, 400 * attempt));
            }
          }
          if (!uploaded) throw new Error(`Video upload stopped at part ${index + 1}.`);
          onStatus(`Uploading ${file.name}: ${Math.round(((index + 1) / chunkCount) * 100)}%…`);
        }
      } else {
        onStatus(`Uploading ${file.name}…`);
        await readUploadResponse(await fetcher(prepared.uploadUrl, {
          method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file,
        }));
      }
      stage = "processing";
      onStatus(`Processing ${file.name}…`);
      const completed = await readUploadResponse(await fetcher("/api/upload/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadToken: prepared.uploadToken }),
      }));
      if (!completed.fileReference || typeof completed.fileReference !== "object") {
        throw new Error("Attachment processing returned no file reference.");
      }
      references.push(completed.fileReference as FileReference);
    } catch (error) {
      if (isVideo) {
        await reportVideoUploadError(fetcher, {
          uploadId, stage,
          message: error instanceof Error ? error.message : String(error),
          chunkIndex, fileBytes: file.size,
        });
      }
      throw error;
    }
  }
  onStatus(`Uploaded ${references.length} file${references.length === 1 ? "" : "s"}.`);
  return references;
}
