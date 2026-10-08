import type { FileReference } from "@/lib/providers/types";
import { captureVideoFallbackFrames } from "./video-fallback-frames";

// v3 uses ~700 KiB JSON bodies. Existing saved v2 sessions retain their 2 MiB boundaries.
export const JSON_VIDEO_SMALL_CHUNK_BYTES = 512 * 1024;
export const JSON_VIDEO_LEGACY_CHUNK_BYTES = 2 * 1024 * 1024;
type VideoTransport = "json-base64-v2" | "json-base64-v3";
const DEFAULT_VIDEO_TRANSPORT: VideoTransport = "json-base64-v3";
const chunkSizeFor = (transport: VideoTransport) =>
  transport === "json-base64-v3" ? JSON_VIDEO_SMALL_CHUNK_BYTES : JSON_VIDEO_LEGACY_CHUNK_BYTES;
export const VIDEO_CHUNK_TIMEOUT_MS = 30_000;
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
type PreparedUpload = { uploadToken: string; uploadUrl: string; uploadId?: string; transport?: VideoTransport };
type Progress = { uploadId: string; chunkCount: number; chunkBytes?: number; transport?: string; uploadedIndexes: number[]; complete: boolean };

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
      const saved = parsed as { uploadToken?: unknown; uploadId?: unknown; savedAt?: unknown; transport?: unknown };
      if (typeof saved.uploadToken === "string" && typeof saved.uploadId === "string" &&
        typeof saved.savedAt === "number" && Date.now() - saved.savedAt < 110 * 60 * 1000 &&
        saved.savedAt <= Date.now() + 30_000) {
        return {
          uploadToken: saved.uploadToken, uploadId: saved.uploadId, uploadUrl: "resumed",
          // Old sessionStorage records omitted transport and always used 2 MiB chunks.
          transport: saved.transport === "json-base64-v3" ? "json-base64-v3" : "json-base64-v2",
        };
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
      uploadToken: prepared.uploadToken, uploadId: prepared.uploadId,
      transport: prepared.transport ?? "json-base64-v2", savedAt: Date.now()
    }));
  } catch { /* Upload continues even without session storage. */ }
}
function clearResumeSession(store: ResumeStorage | null, key: string): void {
  try { store?.removeItem(key); } catch { /* Optional resume storage. */ }
}


class UploadHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "UploadHttpError";
  }
}

async function readUploadResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch { /* Hosting errors can be HTML or plain text. */ }
  if (!response.ok) {
    const message = response.status === 413
      ? "The upload request exceeded the server's size limit."
      : (typeof payload.error === "string" ? payload.error : typeof payload.message === "string" ? payload.message : undefined)
      ?? `Attachment upload failed (HTTP ${response.status}).`;
    throw new UploadHttpError(response.status, message);
  }
  return payload;
}

// v3's 512 KiB slice creates a ~700 KiB JSON body; old v2 receipts remain 2 MiB.
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

type AttemptDiagnostic = {
  uploadId?: string;
  chunkIndex: number;
  attempt: number;
  durationMs: number;
  encodedBytes: number;
  transport: VideoTransport;
  outcome: "success" | "timeout" | "http-error" | "network-error";
  httpStatus?: number;
  detail?: string;
};
function attemptOutcome(error: unknown): AttemptDiagnostic["outcome"] {
  if (error instanceof UploadTimeoutError) return "timeout";
  if (error instanceof UploadHttpError) return "http-error";
  return "network-error";
}
// Every attempt is timed and reported in browser console. Failed and slow (>8s)
// attempts are also reported to Vercel without upload bytes, filenames, or tokens.
async function logChunkAttempt(fetcher: typeof fetch, diagnostic: AttemptDiagnostic): Promise<void> {
  console.info("[Upload Client] video chunk attempt", diagnostic);
  if (diagnostic.outcome === "success" && diagnostic.durationMs < 8_000) return;
  try {
    await withUploadDeadline("Upload attempt telemetry", 2_000, async signal => {
      await fetcher("/api/upload/telemetry", {
        method: "POST", signal, keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: "attempt", uploadId: diagnostic.uploadId,
          chunkIndex: diagnostic.chunkIndex, attempt: diagnostic.attempt,
          durationMs: diagnostic.durationMs, encodedBytes: diagnostic.encodedBytes,
          transport: diagnostic.transport, outcome: diagnostic.outcome,
          httpStatus: diagnostic.httpStatus, detail: diagnostic.detail?.slice(0, 160)
        }),
      });
    });
  } catch { /* Diagnostics never block the real upload for more than 2 seconds. */ }
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
      const indexes: unknown[] = payload.uploadedIndexes;
      const chunkCount = payload.chunkCount as number;
      if (!indexes.every(value => typeof value === "number" && Number.isSafeInteger(value) &&
        value >= 0 && value < chunkCount)) throw new Error("Invalid upload progress indexes.");
      return { uploadId: payload.uploadId, uploadedIndexes: indexes as number[],
        chunkCount, chunkBytes: typeof payload.chunkBytes === "number" ? payload.chunkBytes : undefined,
        transport: typeof payload.transport === "string" ? payload.transport : undefined,
        complete: payload.complete === true };
    });
  };

  for (const file of files) {
    const isVideo = file.type.startsWith("video/");
    const key = isVideo ? resumeKey(file) : "";
    let stage = "prepare";
    let uploadId: string | undefined;
    let chunkIndex: number | undefined;
    try {
      let prepared: PreparedUpload | null = isVideo ? readResumeSession(resumeStorage, key) : null;
      let transport: VideoTransport = prepared?.transport ?? DEFAULT_VIDEO_TRANSPORT;
      let chunkBytes = chunkSizeFor(transport);
      let chunkCount = isVideo ? Math.ceil(file.size / chunkBytes) : 0;
      let completedChunks = new Set<number>();
      if (prepared) {
        try {
          onStatus(`Checking saved progress for ${file.name}…`);
          const saved = await status(prepared.uploadToken);
          if (saved.chunkCount !== chunkCount || saved.uploadId !== prepared.uploadId ||
              (saved.chunkBytes != null && saved.chunkBytes !== chunkBytes) ||
              (saved.transport && saved.transport !== transport))
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
        transport = DEFAULT_VIDEO_TRANSPORT;
        chunkBytes = chunkSizeFor(transport);
        chunkCount = isVideo ? Math.ceil(file.size / chunkBytes) : 0;
        onStatus(`Preparing ${file.name}…`);
        const payload = await withUploadDeadline("Preparing video upload", 30_000, async signal =>
          readUploadResponse(await fetcher("/api/upload/prepare", {
            method: "POST", signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: file.name, type: file.type, size: file.size,
              ...(isVideo ? { transport } : {})
            }),
          }))
        );
        if (typeof payload.uploadUrl !== "string" || typeof payload.uploadToken !== "string")
          throw new Error("Unable to prepare attachment upload.");
        prepared = { uploadToken: payload.uploadToken, uploadUrl: payload.uploadUrl,
          uploadId: typeof payload.uploadId === "string" ? payload.uploadId : undefined,
          ...(isVideo ? { transport } : {}) };
        if (isVideo) saveResumeSession(resumeStorage, key, prepared);
      }
      uploadId = prepared.uploadId;
      stage = "transfer";
      if (isVideo) {
        // Supabase stores each signed chunk by index, so they can arrive in any order.
        // A bounded adaptive work queue prevents one stalled request from blocking
        // unrelated chunks. Never launch all chunks together (up to 400 per video).
        const missingIndexes = Array.from({ length: chunkCount }, (_, index) => index)
          .filter(index => !completedChunks.has(index));
        let concurrency = 3;
        let healthyStreak = 0;

        const uploadPart = async (index: number): Promise<{ healthy: boolean }> => {
          const offset = index * chunkBytes;
          const slice = file.slice(offset, Math.min(offset + chunkBytes, file.size));
          // Encode once per chunk, even when one worker retries multiple times.
          const data = await withUploadDeadline(`Encoding video part ${index + 1}`, 15_000,
            async () => videoSliceAsBase64(slice));
          const uploadBody = JSON.stringify({ uploadToken: prepared.uploadToken, index, data });
          let encounteredFailure = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            const started = Date.now();
            try {
              await withUploadDeadline(`Video part ${index + 1}/${chunkCount}`, chunkTimeoutMs, async signal => {
                await readUploadResponse(await fetcher("/api/upload/chunk", {
                  method: "POST", signal,
                  headers: { "Content-Type": "application/json" }, body: uploadBody,
                }));
              });
              const durationMs = Date.now() - started;
              await logChunkAttempt(fetcher, {
                uploadId, chunkIndex: index, attempt, durationMs,
                encodedBytes: data.length, transport, outcome: "success"
              });
              return { healthy: !encounteredFailure && durationMs < 8_000 };
            } catch (error) {
              encounteredFailure = true;
              // Back off immediately. Already-running requests finish independently;
              // newly scheduled requests respect the reduced worker count.
              concurrency = Math.max(2, concurrency - 1);
              healthyStreak = 0;
              await logChunkAttempt(fetcher, {
                uploadId, chunkIndex: index, attempt, durationMs: Date.now() - started,
                encodedBytes: data.length, transport, outcome: attemptOutcome(error),
                ...(error instanceof UploadHttpError ? { httpStatus: error.status } : {}),
                detail: error instanceof Error ? error.message : "Unknown video transport error",
              });
              // The server might have committed the part but its acknowledgement
              // vanished. A signed status check avoids duplicate uploads.
              const shouldCheckSaved = !(error instanceof UploadHttpError) || error.status >= 500;
              if (shouldCheckSaved) {
                onStatus(`Video part ${index + 1} interrupted; checking saved progress…`);
                try {
                  const saved = await status(prepared.uploadToken);
                  if (saved.uploadId === prepared.uploadId && saved.chunkCount === chunkCount &&
                      saved.uploadedIndexes.includes(index)) {
                    return { healthy: false };
                  }
                } catch { /* Status checks are bounded; preserve the independent retry. */ }
              }
              if (attempt === 3) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`Video upload failed at part ${index + 1}/${chunkCount}: ${detail}. Saved chunks can be resumed by selecting this file again.`);
              }
              onStatus(`Retrying ${file.name}: part ${index + 1}/${chunkCount} (attempt ${attempt + 1}/3, ${concurrency} parallel)…`);
              await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
            }
          }
          throw new Error(`Video upload stopped at part ${index + 1}.`);
        };

        await new Promise<void>((resolve, reject) => {
          let next = 0;
          let active = 0;
          let stopped = false;
          let firstFailure: Error | null = null;

          const dispatch = () => {
            if (stopped) return;
            while (!firstFailure && active < concurrency && next < missingIndexes.length) {
              const index = missingIndexes[next++];
              active++;
              void uploadPart(index).then(({ healthy }) => {
                completedChunks.add(index);
                if (healthy) {
                  healthyStreak++;
                  // Increase 3 -> 4 only after sustained fast, error-free transfers.
                  // If previously reduced to 2, recover cautiously through 3.
                  if (healthyStreak >= 6 && concurrency < 4) {
                    concurrency++;
                    healthyStreak = 0;
                    console.info("[Upload Client] video concurrency increased", { uploadId, concurrency });
                  }
                } else {
                  healthyStreak = 0;
                }
                onStatus(`Uploading ${file.name}: ${Math.round((completedChunks.size / chunkCount) * 100)}% (${concurrency} parallel)…`);
              }).catch(error => {
                if (!firstFailure) {
                  chunkIndex = index;
                  firstFailure = error instanceof Error ? error : new Error(String(error));
                }
              }).finally(() => {
                active--;
                dispatch();
              });
            }
            // On an exhausted chunk, stop scheduling new ones but let every
            // in-flight worker settle before reporting failure or finalizing.
            if (active === 0 && (firstFailure || next >= missingIndexes.length)) {
              stopped = true;
              if (firstFailure) reject(firstFailure);
              else resolve();
            }
          };
          dispatch();
        });
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
