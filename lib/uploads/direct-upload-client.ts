import type { FileReference } from "@/lib/providers/types";
import { captureVideoFallbackFrames } from "./video-fallback-frames";

const JSON_VIDEO_CHUNK_BYTES = 2 * 1024 * 1024;
export const VIDEO_CHUNK_TIMEOUT_MS = 45_000;
const VIDEO_STATUS_TIMEOUT_MS = 12_000;
const VIDEO_COMPLETION_TIMEOUT_MS = 180_000;

export class UploadTimeoutError extends Error {
  constructor(stage: string, timeoutMs: number) {
    super(`${stage} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
    this.name = "UploadTimeoutError";
  }
}

// The watchdog wraps both file encoding and the entire HTTP response. Abort
// alone is insufficient: embedded mobile webviews sometimes ignore abort signals.
async function withUploadDeadline<T>(
  stage: string, timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new UploadTimeoutError(stage, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type ResumeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type VideoUploadOptions = {
  chunkTimeoutMs?: number;
  statusTimeoutMs?: number;
  retryDelayMs?: number;
  resumeStorage?: ResumeStorage | null;
};
type PreparedUpload = { uploadToken: string; uploadUrl: string; uploadId?: string };
type Progress = { uploadId: string; chunkCount: number; uploadedIndexes: number[]; complete: boolean };

function browserResumeStorage(): ResumeStorage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; }
  catch { return null; }
}
function resumeKey(file: File): string {
  return `katie:video-session:v1:${encodeURIComponent(file.name)}:${file.type}:${file.size}:${file.lastModified}`;
}
function readResumeSession(store: ResumeStorage | null, key: string): PreparedUpload | null {
  if (!store) return null;
  try {
    const value = store.getItem(key);
    if (!value) return null;
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      const saved = parsed as { uploadToken?: unknown; uploadId?: unknown; savedAt?: unknown };
      if (typeof saved.uploadToken === "string" && typeof saved.uploadId === "string" &&
        typeof saved.savedAt === "number" && Date.now() - saved.savedAt < 110 * 60 * 1000 &&
        saved.savedAt <= Date.now() + 30_000) {
        return { uploadToken: saved.uploadToken, uploadId: saved.uploadId, uploadUrl: "resumed" };
      }
    }
  } catch { /* Invalid browser state is discarded. */ }
  try { store.removeItem(key); } catch { /* Optional resume storage. */ }
  return null;
}
function saveResumeSession(store: ResumeStorage | null, key: string, prepared: PreparedUpload): void {
  if (!store || !prepared.uploadId) return;
  try {
    store.setItem(key, JSON.stringify({
      uploadToken: prepared.uploadToken, uploadId: prepared.uploadId, savedAt: Date.now()
    }));
  } catch { /* Upload continues even without session storage. */ }
}
function clearResumeSession(store: ResumeStorage | null, key: string): void {
  try { store?.removeItem(key); } catch { /* Optional resume storage. */ }
}


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
    await withUploadDeadline("Upload diagnostics", 4_000, async signal => {
      await fetcher("/api/upload/telemetry", {
        method: "POST", signal,
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
    });
  } catch { /* Diagnostics must never mask the original upload failure. */ }
}

export async function uploadFilesDirect(
  files: File[], onStatus: (message: string) => void = () => {}, fetcher: typeof fetch = fetch,
  captureFrames: typeof captureVideoFallbackFrames = captureVideoFallbackFrames,
  options: VideoUploadOptions = {},
): Promise<FileReference[]> {
  if (files.length > 5) throw new Error("Too many files. Maximum allowed is 5.");
  const references: FileReference[] = [];
  const resumeStorage = options.resumeStorage === undefined ? browserResumeStorage() : options.resumeStorage;
  const chunkTimeoutMs = options.chunkTimeoutMs ?? VIDEO_CHUNK_TIMEOUT_MS;
  const statusTimeoutMs = options.statusTimeoutMs ?? VIDEO_STATUS_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? 400;

  const status = async (token: string): Promise<Progress> => {
    return await withUploadDeadline("Checking saved video progress", statusTimeoutMs, async signal => {
      const payload = await readUploadResponse(await fetcher("/api/upload/status", {
        method: "POST", signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadToken: token })
      }));
      if (!Array.isArray(payload.uploadedIndexes) || typeof payload.chunkCount !== "number" ||
          typeof payload.uploadId !== "string") throw new Error("Invalid saved upload progress.");
      const indexes = payload.uploadedIndexes;
      if (!indexes.every(value => typeof value === "number" && Number.isSafeInteger(value) &&
        value >= 0 && value < payload.chunkCount)) throw new Error("Invalid upload progress indexes.");
      return { uploadId: payload.uploadId, uploadedIndexes: indexes as number[],
        chunkCount: payload.chunkCount, complete: payload.complete === true };
    });
  };

  for (const file of files) {
    const isVideo = file.type.startsWith("video/");
    const key = isVideo ? resumeKey(file) : "";
    let stage = "prepare";
    let uploadId: string | undefined;
    let chunkIndex: number | undefined;
    try {
      const chunkCount = isVideo ? Math.ceil(file.size / JSON_VIDEO_CHUNK_BYTES) : 0;
      let prepared: PreparedUpload | null = isVideo ? readResumeSession(resumeStorage, key) : null;
      let completedChunks = new Set<number>();
      if (prepared) {
        try {
          onStatus(`Checking saved progress for ${file.name}…`);
          const saved = await status(prepared.uploadToken);
          if (saved.chunkCount !== chunkCount || saved.uploadId !== prepared.uploadId)
            throw new Error("Saved upload does not match this video.");
          completedChunks = new Set(saved.uploadedIndexes);
          onStatus(`Resuming ${file.name}: ${Math.round((completedChunks.size / chunkCount) * 100)}% saved…`);
        } catch {
          // Expired/tampered tickets or failed status checks cannot be trusted.
          clearResumeSession(resumeStorage, key);
          prepared = null;
        }
      }
      if (!prepared) {
        onStatus(`Preparing ${file.name}…`);
        const payload = await withUploadDeadline("Preparing video upload", 30_000, async signal =>
          readUploadResponse(await fetcher("/api/upload/prepare", {
            method: "POST", signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: file.name, type: file.type, size: file.size,
              ...(isVideo ? { transport: "json-base64-v2" } : {})
            }),
          }))
        );
        if (typeof payload.uploadUrl !== "string" || typeof payload.uploadToken !== "string")
          throw new Error("Unable to prepare attachment upload.");
        prepared = { uploadToken: payload.uploadToken, uploadUrl: payload.uploadUrl,
          uploadId: typeof payload.uploadId === "string" ? payload.uploadId : undefined };
        if (isVideo) saveResumeSession(resumeStorage, key, prepared);
      }
      uploadId = prepared.uploadId;
      stage = "transfer";
      if (isVideo) {
        for (let index = 0; index < chunkCount; index++) {
          chunkIndex = index;
          if (completedChunks.has(index)) continue;
          const offset = index * JSON_VIDEO_CHUNK_BYTES;
          const slice = file.slice(offset, Math.min(offset + JSON_VIDEO_CHUNK_BYTES, file.size));
          let uploaded = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await withUploadDeadline(`Video part ${index + 1}/${chunkCount}`, chunkTimeoutMs, async signal => {
                const data = await videoSliceAsBase64(slice);
                await readUploadResponse(await fetcher("/api/upload/chunk", {
                  method: "POST", signal,
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ uploadToken: prepared!.uploadToken, index, data })
                }));
              });
              uploaded = true;
              break;
            } catch (error) {
              // The server might have saved a part before the browser timed out
              // waiting for its acknowledgement. Check before sending it again.
              if (error instanceof UploadTimeoutError) {
                onStatus(`Video part ${index + 1} stalled; checking saved progress…`);
                try {
                  const saved = await status(prepared.uploadToken);
                  if (saved.uploadId === prepared.uploadId && saved.chunkCount === chunkCount &&
                      saved.uploadedIndexes.includes(index)) {
                    uploaded = true;
                    break;
                  }
                } catch { /* Retry original request if the status endpoint also times out. */ }
              }
              if (attempt === 3) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`Video upload failed at part ${index + 1}/${chunkCount}: ${detail}. Saved chunks can be resumed by selecting this file again.`);
              }
              onStatus(`Retrying ${file.name}: part ${index + 1}/${chunkCount} (attempt ${attempt + 1}/3)…`);
              await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
            }
          }
          if (!uploaded) throw new Error(`Video upload stopped at part ${index + 1}.`);
          completedChunks.add(index);
          onStatus(`Uploading ${file.name}: ${Math.round((completedChunks.size / chunkCount) * 100)}%…`);
        }
      } else {
        onStatus(`Uploading ${file.name}…`);
        await readUploadResponse(await fetcher(prepared.uploadUrl, {
          method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file,
        }));
      }
      stage = "processing";
      onStatus(`Processing ${file.name}…`);
      const videoFrames = isVideo ? await captureFrames(file).catch(() => []) : [];
      if (isVideo) onStatus(videoFrames.length
        ? `Saved ${videoFrames.length} video preview frames for backup analysis…`
        : "Video uploaded; backup frame extraction unavailable.");
      // Completing may involve Google's video ACTIVE processing; give it a longer
      // deadline than an individual chunk, and safely retry the idempotent request.
      let completed: Record<string, unknown> | null = null;
      for (let attempt = 1; attempt <= (isVideo ? 2 : 1); attempt++) {
        try {
          completed = await withUploadDeadline("Processing video", VIDEO_COMPLETION_TIMEOUT_MS, async signal =>
            readUploadResponse(await fetcher("/api/upload/complete", {
              method: "POST", signal,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ uploadToken: prepared!.uploadToken, ...(isVideo ? { videoFrames } : {}) }),
            }))
          );
          break;
        } catch (error) {
          if (attempt === (isVideo ? 2 : 1)) throw error;
          onStatus(`Finalizing ${file.name} again without reuploading…`);
        }
      }
      if (!completed?.fileReference || typeof completed.fileReference !== "object")
        throw new Error("Attachment processing returned no file reference.");
      references.push(completed.fileReference as FileReference);
      if (isVideo) clearResumeSession(resumeStorage, key);
    } catch (error) {
      if (isVideo) {
        await reportVideoUploadError(fetcher, {
          uploadId, stage,
          message: error instanceof Error ? error.message : String(error),
          chunkIndex, fileBytes: file.size
        });
      }
      throw error;
    }
  }
  onStatus(`Uploaded ${references.length} file${references.length === 1 ? "" : "s"}.`);
  return references;
}
