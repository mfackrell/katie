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
export async function readPendingAttachments(id: string) {
  if (memory.has(id)) return memory.get(id);
  const db = await database();
  try {
    return await new Promise<PendingAttachments | undefined>(
      (resolve, reject) => {
        const req = db
          .transaction("conversations")
          .objectStore("conversations")
          .get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      },
    );
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
