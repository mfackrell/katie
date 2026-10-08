import type { FileReference } from "@/lib/providers/types";

async function readUploadResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch { /* Hosting errors are often plain text or HTML. */ }
  if (!response.ok) {
    if (response.status === 413) throw new Error("This attachment exceeds the storage upload size limit. Choose a smaller file.");
    const message = typeof payload.error === "string" ? payload.error : typeof payload.message === "string" ? payload.message : undefined;
    throw new Error(message ?? `Attachment upload failed (HTTP ${response.status}). Please try again.`);
  }
  return payload;
}

export async function uploadFilesDirect(
  files: File[], onStatus: (message: string) => void = () => {}, fetcher: typeof fetch = fetch,
): Promise<FileReference[]> {
  if (files.length > 5) throw new Error("Too many files. Maximum allowed is 5.");
  const references: FileReference[] = [];
  for (const file of files) {
    onStatus(`Preparing ${file.name}…`);
    const prepared = await readUploadResponse(await fetcher("/api/upload/prepare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, type: file.type, size: file.size }),
    }));
    if (typeof prepared.uploadUrl !== "string" || typeof prepared.uploadToken !== "string") {
      throw new Error("Unable to prepare attachment upload. Please try again.");
    }
    if (file.type.startsWith("video/")) {
      // iOS embedded browsers can complete the Storage CORS preflight but never
      // dispatch the cross-origin PUT. Video bytes now travel in bounded,
      // first-party requests; the server reassembles them in private Storage.
      const chunkBytes = 3 * 1024 * 1024;
      const chunkCount = Math.ceil(file.size / chunkBytes);
      for (let index = 0; index < chunkCount; index++) {
        const start = index * chunkBytes;
        const slice = file.slice(start, Math.min(start + chunkBytes, file.size));
        let uploaded = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const response = await fetcher("/api/upload/chunk", {
              method: "POST",
              headers: {
                "Content-Type": "application/octet-stream",
                "x-katie-upload-token": prepared.uploadToken,
                "x-katie-chunk-index": String(index),
              },
              body: slice,
            });
            await readUploadResponse(response);
            uploaded = true;
            break;
          } catch (error) {
            if (attempt === 3) {
              const detail = error instanceof Error ? error.message : String(error);
              throw new Error(`Video upload stopped at part ${index + 1}/${chunkCount}: ${detail}`);
            }
            onStatus(`Retrying ${file.name} at ${Math.floor((start / file.size) * 100)}%…`);
            await new Promise(resolve => setTimeout(resolve, 400 * attempt));
          }
        }
        if (!uploaded) throw new Error(`Unable to upload video part ${index + 1}.`);
        onStatus(`Uploading ${file.name}: ${Math.round(((index + 1) / chunkCount) * 100)}%…`);
      }
    } else {
      onStatus(`Uploading ${file.name}…`);
      // Files that already work use the existing signed direct-storage path.
      await readUploadResponse(await fetcher(prepared.uploadUrl, {
        method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file,
      }));
    }
    onStatus(`Processing ${file.name}…`);
    const completed = await readUploadResponse(await fetcher("/api/upload/complete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadToken: prepared.uploadToken }),
    }));
    if (!completed.fileReference || typeof completed.fileReference !== "object") {
      throw new Error("Attachment processing returned no file reference. Please try again.");
    }
    references.push(completed.fileReference as FileReference);
  }
  onStatus(`Uploaded ${references.length} file${references.length === 1 ? "" : "s"}.`);
  return references;
}
