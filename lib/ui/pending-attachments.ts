import type { FileReference } from "@/lib/providers/types";
export type PendingAttachments = {
  images: string[];
  imageFiles: File[];
  videos: File[];
  files: File[];
  references: FileReference[];
};
const memory = new Map<string, PendingAttachments>();
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("katie-pending-input-v1", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("conversations");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
/** Image references in retry state are uploaded receipts, not a fresh selection.
 * Explicit composer images live in images/imageFiles and are preserved. */
export function cleanPendingAttachments(value: PendingAttachments): PendingAttachments {
  return {...value, references: value.references.filter(reference =>
    reference.attachmentKind !== "image" && !reference.mimeType.startsWith("image/"))};
}
export async function readPendingAttachments(id: string) {
  if (memory.has(id)) {
    const value = cleanPendingAttachments(memory.get(id)!);
    await savePendingAttachments(id, value);
    return value;
  }
  const db = await database();
  try {
    const stored = await new Promise<PendingAttachments | undefined>(
      (resolve, reject) => {
        const req = db
          .transaction("conversations")
          .objectStore("conversations")
          .get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      },
    );
    if (!stored) return;
    const cleaned = cleanPendingAttachments(stored);
    // Await the durable rewrite before exposing restored composer state.
    await savePendingAttachments(id, cleaned);
    return cleaned;
  } finally {
    db.close();
  }
}
export async function savePendingAttachments(
  id: string,
  value: PendingAttachments,
) {
  memory.set(id, value);
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("conversations", "readwrite");
      const store = tx.objectStore("conversations");
      if (
        value.images.length ||
        value.imageFiles.length ||
        value.videos.length ||
        value.files.length ||
        value.references.length
      )
        store.put(value, id);
      else store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
