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
type Progress = { uploadId: string; chunkCount: number; chunkBytes?: number; transport?: string;
  uploadedIndexes: number[]; uploadedSubIndexes?: number[]; complete: boolean };

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
      const subIndexes: unknown[] = Array.isArray(payload.uploadedSubIndexes) ? payload.uploadedSubIndexes : [];
      if (!subIndexes.every(value => typeof value === "number" && Number.isSafeInteger(value) &&
        value >= 0 && value < chunkCount * 4)) throw new Error("Invalid saved upload subparts.");
      return { uploadId: payload.uploadId, uploadedIndexes: indexes as number[],
        uploadedSubIndexes: subIndexes as number[], chunkCount,
        chunkBytes: typeof payload.chunkBytes === "number" ? payload.chunkBytes : undefined,
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
      let completedSubParts = new Set<number>();
      if (prepared) {
        try {
          onStatus(`Checking saved progress for ${file.name}…`);
          const saved = await status(prepared.uploadToken);
          if (saved.chunkCount !== chunkCount || saved.uploadId !== prepared.uploadId ||
              (saved.chunkBytes != null && saved.chunkBytes !== chunkBytes) ||
              (saved.transport && saved.transport !== transport))
            throw new Error("Saved upload does not match this video.");
          completedChunks = new Set(saved.uploadedIndexes);
          completedSubParts = new Set(saved.uploadedSubIndexes ?? []);
          const savedParts = transport === "json-base64-v2"
            ? Array.from({ length: chunkCount }, (_, index) => {
              const size = Math.min(chunkBytes, file.size - index * chunkBytes);
              const subCount = Math.ceil(size / JSON_VIDEO_SMALL_CHUNK_BYTES);
              return completedChunks.has(index) ? subCount :
                Array.from({ length: subCount }, (_, sub) => completedSubParts.has(index * 4 + sub) ? 1 : 0)
                  .reduce<number>((a, b) => a + b, 0);
            }).reduce((a, b) => a + b, 0)
            : completedChunks.size;
          const totalParts = transport === "json-base64-v2"
            ? Math.ceil(file.size / JSON_VIDEO_SMALL_CHUNK_BYTES) : chunkCount;
          onStatus(`Resuming ${file.name}: ${Math.round((savedParts / totalParts) * 100)}% saved…`);
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
        // For old v2 tickets, retain previously uploaded 2 MiB chunks but
        // send every missing byte as a small 512 KiB signed subchunk. An old
        // interrupted session must NEVER fall back to 2.8 MB HTTP requests.
        const legacyV2 = transport === "json-base64-v2";
        type WorkUnit = { index: number; subIndex?: number; offset: number; size: number; ordinal: number };
        const missingUnits: WorkUnit[] = [];
        let acknowledgedUnits = 0;
        let totalUnits = 0;
        for (let index = 0; index < chunkCount; index++) {
          const originalStart = index * chunkBytes;
          const originalSize = Math.min(chunkBytes, file.size - originalStart);
          const unitSize = legacyV2 ? JSON_VIDEO_SMALL_CHUNK_BYTES : chunkBytes;
          const subCount = Math.ceil(originalSize / unitSize);
          for (let sub = 0; sub < subCount; sub++) {
            const ordinal = totalUnits++;
            const alreadyUploaded = completedChunks.has(index) ||
              (legacyV2 && completedSubParts.has(index * 4 + sub));
            if (alreadyUploaded) { acknowledgedUnits++; continue; }
            missingUnits.push({
              index, ...(legacyV2 ? { subIndex: sub } : {}),
              offset: originalStart + sub * unitSize,
              size: Math.min(unitSize, originalSize - sub * unitSize),
              ordinal,
            });
          }
        }
        let concurrency = 3;
        let healthyStreak = 0;

        const uploadPart = async (unit: WorkUnit): Promise<{ healthy: boolean }> => {
          const { index, subIndex, ordinal, offset } = unit;
          const slice = file.slice(offset, offset + unit.size);
          // Encode once per chunk, even when one worker retries multiple times.
          const data = await withUploadDeadline(`Encoding video part ${index + 1}`, 15_000,
            async () => videoSliceAsBase64(slice));
          const uploadBody = JSON.stringify({
            uploadToken: prepared.uploadToken, index,
            ...(subIndex !== undefined ? { subIndex } : {}), data
          });
          let encounteredFailure = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            const started = Date.now();
            try {
              await withUploadDeadline(`Video part ${ordinal + 1}/${totalUnits}`, chunkTimeoutMs, async signal => {
                await readUploadResponse(await fetcher("/api/upload/chunk", {
                  method: "POST", signal,
                  headers: { "Content-Type": "application/json" }, body: uploadBody,
                }));
              });
              const durationMs = Date.now() - started;
              await logChunkAttempt(fetcher, {
                uploadId, chunkIndex: ordinal, attempt, durationMs,
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
                uploadId, chunkIndex: ordinal, attempt, durationMs: Date.now() - started,
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
                      (saved.uploadedIndexes.includes(index) ||
                        (subIndex !== undefined && saved.uploadedSubIndexes?.includes(index * 4 + subIndex)))) {
                    return { healthy: false };
                  }
                } catch { /* Status checks are bounded; preserve the independent retry. */ }
              }
              if (attempt === 3) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`Video upload failed at part ${ordinal + 1}/${totalUnits}: ${detail}. Saved chunks can be resumed by selecting this file again.`);
              }
              onStatus(`Retrying ${file.name}: part ${ordinal + 1}/${totalUnits} (attempt ${attempt + 1}/3, ${concurrency} parallel)…`);
              await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
            }
          }
          throw new Error(`Video upload stopped at part ${ordinal + 1}.`);
        };

        await new Promise<void>((resolve, reject) => {
          let next = 0;
          let active = 0;
          let stopped = false;
          let firstFailure: Error | null = null;

          const dispatch = () => {
            if (stopped) return;
            while (!firstFailure && active < concurrency && next < missingUnits.length) {
              const unit = missingUnits[next++];
              active++;
              void uploadPart(unit).then(({ healthy }) => {
                acknowledgedUnits++;
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
                onStatus(`Uploading ${file.name}: ${Math.round((acknowledgedUnits / totalUnits) * 100)}% (${concurrency} parallel)…`);
              }).catch(error => {
                if (!firstFailure) {
                  chunkIndex = unit.ordinal;
                  firstFailure = error instanceof Error ? error : new Error(String(error));
                }
              }).finally(() => {
                active--;
                dispatch();
              });
            }
            // On an exhausted chunk, stop scheduling new ones but let every
            // in-flight worker settle before reporting failure or finalizing.
            if (active === 0 && (firstFailure || next >= missingUnits.length)) {
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
      // Video frames are recovered on demand from the retained private original.
      // Never decode the video on the phone or send a multi-megabyte finalization
      // payload that may fail before it reaches Vercel.
      void captureFrames;
      let completed: Record<string, unknown> | null = null;
      if (isVideo) {
        // Start a detached server job and poll with small independent requests.
        // Losing any mobile HTTP connection does not restart the original upload.
        const startedAt = Date.now();
        const maxWaitMs = 8 * 60_000;
        let kicks = 0;
        let nextKickAt = 0;
        let lastServerError = "";
        let pollsFailed = 0;
        let lastStatus = "";
        while (Date.now() - startedAt < maxWaitMs) {
          if (Date.now() >= nextKickAt && kicks < 4) {
            kicks++;
            nextKickAt = Date.now() + 30_000;
            try {
              const kickoff = await withUploadDeadline("Starting video processing", 15_000, async signal =>
                readUploadResponse(await fetcher("/api/upload/complete", {
                  method: "POST", signal,
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ uploadToken: prepared.uploadToken, background: true }),
                }))
              );
              if (kickoff.fileReference && typeof kickoff.fileReference === "object") {
                completed = kickoff;
                break;
              }
              nextKickAt = Date.now() + 5 * 60_000;
            } catch (error) {
              lastServerError = error instanceof Error ? error.message : String(error);
              // The server may already have accepted the kickoff. Poll its
              // durable state before attempting to schedule the job again.
              nextKickAt = Date.now() + 12_000;
              console.warn("[Upload Client] video processing kickoff connection failed", {
                uploadId, attempt: kicks, message: lastServerError,
              });
            }
          }
          try {
            const result = await withUploadDeadline("Checking video processing", 15_000, async signal =>
              readUploadResponse(await fetcher("/api/upload/result", {
                method: "POST", signal,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ uploadToken: prepared.uploadToken }),
              }))
            );
            pollsFailed = 0;
            if (result.status === "ready" && result.fileReference &&
                typeof result.fileReference === "object") {
              completed = result;
              break;
            }
            if (result.status === "failed") {
              lastServerError = typeof result.error === "string" ? result.error : "Server video processing failed.";
              if (kicks >= 4) throw new Error(lastServerError);
              // Retry provider processing from the stored original. Nothing is
              // uploaded from the device again.
              nextKickAt = 0;
              if (lastStatus !== "failed") onStatus(`Video processing interrupted; retrying from saved upload…`);
            } else if (result.status === "pending") {
              // The kickoff might have been lost in transit before the server
              // accepted it. Reissue a tiny request rather than the video.
              nextKickAt = Math.min(nextKickAt, Date.now() + 3_000);
            } else if (result.status === "processing") {
              // A processing job is already underway; never schedule another
              // merely because its initial HTTP acknowledgement was lost.
              const beganAt = typeof result.startedAt === "number" ? result.startedAt : Date.now();
              nextKickAt = Date.now() - beganAt >= 5 * 60_000
                ? 0 : Math.max(nextKickAt, beganAt + 5 * 60_000);
            }
            if (result.status !== lastStatus) {
              lastStatus = typeof result.status === "string" ? result.status : "processing";
              if (lastStatus === "processing") onStatus(`Processing ${file.name} securely on the server…`);
            }
          } catch (error) {
            pollsFailed++;
            const detail = error instanceof Error ? error.message : String(error);
            if (detail === lastServerError && kicks >= 4) throw error;
            lastServerError = detail;
            if (pollsFailed >= 5) {
              onStatus(`Connection interrupted while processing ${file.name}; retrying status check…`);
            }
          }
          await new Promise(resolve => setTimeout(resolve, 2_000));
        }
        if (!completed) {
          throw new Error(`Video parts are saved, but processing did not finish: ${lastServerError || "the processing service did not complete within eight minutes"}. You can retry with the same video without uploading saved parts again.`);
        }
      } else {
        completed = await withUploadDeadline("Processing attachment", VIDEO_COMPLETION_TIMEOUT_MS, async signal =>
          readUploadResponse(await fetcher("/api/upload/complete", {
            method: "POST", signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uploadToken: prepared.uploadToken }),
          }))
        );
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
