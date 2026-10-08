import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ConversationAttachment } from "@/lib/chat/attachment-continuity";
import type { FileReference } from "@/lib/providers/types";
import { buildFileReferences, validateUploadFiles } from "./build-file-references";
import { validateVideoFallbackFrames } from "./video-fallback-frames";
import { extractFramesFromPrivateVideo } from "./server-video-frame-recovery";

const BUCKET = "katie-attachments";
const RETENTION_MS = 24 * 60 * 60 * 1000;
// Below Vercel's 4.5 MB request-body limit; allows uploads without browser-to-Storage CORS.
export const UPLOAD_RELAY_CHUNK_BYTES = 3 * 1024 * 1024;
// Preserve 2 MiB uploads prepared before the smaller v3 transport was deployed.
export const UPLOAD_JSON_CHUNK_BYTES = 2 * 1024 * 1024;
// v3 sends ~700 KiB JSON requests instead of ~2.8 MiB JSON requests.
export const UPLOAD_JSON_SMALL_CHUNK_BYTES = 512 * 1024;
export const uploadMetadataSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.string().max(128),
  size: z.number().int().positive().max(200 * 1024 * 1024),
  transport: z.enum(["json-base64-v2", "json-base64-v3"]).optional(),
});
const ticketSchema = uploadMetadataSchema.extend({
  id: z.string().uuid(), kind: z.enum(["upload", "reference"]), expires: z.number().int().positive(),
});
type Ticket = z.infer<typeof ticketSchema>;
type Storage = ReturnType<typeof createClient>["storage"];

export class UploadInputError extends Error {}

export function createStoredUploadService(storage: Storage, secret: string, options: {
  now?: () => number;
  buildReferences?: typeof buildFileReferences;
} = {}) {
  const now = options.now ?? Date.now;
  const buildReferences = options.buildReferences ?? buildFileReferences;
  const objects = storage.from(BUCKET);
  const sign = (ticket: Ticket): string => {
    const body = Buffer.from(JSON.stringify(ticket)).toString("base64url");
    return `${body}.${createHmac("sha256", secret).update(`katie-upload:v1:${body}`).digest("base64url")}`;
  };
  const verify = (token: string, kind: Ticket["kind"]): Ticket => {
    try {
      if (token.length > 3000) throw new Error();
      const parts = token.split(".");
      if (parts.length !== 2) throw new Error();
      const expected = createHmac("sha256", secret).update(`katie-upload:v1:${parts[0]}`).digest();
      const actual = Buffer.from(parts[1], "base64url");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
      const ticket = ticketSchema.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString()));
      if (ticket.kind !== kind || ticket.expires <= now()) throw new Error();
      return ticket;
    } catch {
      throw new UploadInputError("This attachment reference is invalid or expired. Please attach the file again.");
    }
  };
  const sourcePath = (ticket: Ticket) => `incoming/${ticket.id}`;
  const chunkBytesFor = (ticket: Ticket) => ticket.transport === "json-base64-v3"
    ? UPLOAD_JSON_SMALL_CHUNK_BYTES
    : ticket.transport === "json-base64-v2" ? UPLOAD_JSON_CHUNK_BYTES : UPLOAD_RELAY_CHUNK_BYTES;
  const chunkPath = (ticket: Ticket, index: number) => `chunks/${ticket.id}-${String(index).padStart(3, "0")}`;
  // New browsers may finish old v2 receipts in 512 KiB parts without re-uploading
  // complete 2 MiB chunks or changing the already signed session layout.
  const subChunkPath = (ticket: Ticket, index: number, subIndex: number) =>
    `${chunkPath(ticket, index)}-sub-${String(subIndex).padStart(3, "0")}`;
  const referencePath = (ticket: Ticket) => `references/${ticket.id}.json`;
  const compact = (reference: FileReference, ticket: Ticket): FileReference => {
    const metadata = { ...reference };
    delete metadata.extractedText;
    delete metadata.extractedChunks;
    delete metadata.imageDataUrl;
    delete metadata.videoFrames; // Server hydrates sampled frames from private storage; avoid re-sending evidence as client data.
    return { ...metadata, storageToken: sign({ ...ticket, kind: "reference", expires: ticket.expires + RETENTION_MS - 2 * 60 * 60 * 1000 }) };
  };
  async function ensureBucket() {
    let { data, error } = await storage.getBucket(BUCKET);
    if (!data) {
      const created = await storage.createBucket(BUCKET, { public: false });
      if (created.error) {
        // Another instance can create the bucket between lookup and creation.
        const existing = await storage.getBucket(BUCKET);
        data = existing.data;
        error = existing.error;
        if (!data) throw new Error(`Attachment storage is unavailable: ${error?.message ?? created.error.message}`);
      }
    }
    if (data?.public) throw new Error("Attachment storage must be private.");
  }
  async function cleanExpiredObjects() {
    // Bounded, opportunistic cleanup also removes abandoned uploads.
    for (const prefix of ["incoming", "references", "chunks"]) {
      const { data, error } = await objects.list(prefix, { limit: 100, sortBy: { column: "created_at", order: "asc" } });
      if (error) { console.warn("[Upload API] cleanup listing failed", { prefix }); continue; }
      const expired = (data ?? []).filter(item => item.created_at && Date.parse(item.created_at) < now() - RETENTION_MS);
      if (expired.length) {
        const removed = await objects.remove(expired.map(item => `${prefix}/${item.name}`));
        if (removed.error) console.warn("[Upload API] expired attachment cleanup failed", { prefix });
      }
    }
  }
  const conversationPath = (chatId: string, id: string) => {
    if (!z.string().uuid().safeParse(chatId).success || !z.string().uuid().safeParse(id).success) throw new UploadInputError("Invalid conversation attachment.");
    return `chats/${chatId}/${id}`;
  };
  const catalogPrefix = (chatId: string, scope: "chat" | "actor" = "chat") => {
    if (!z.string().uuid().safeParse(chatId).success) throw new UploadInputError("Invalid conversation.");
    return `${scope === "actor" ? "actor-catalog" : "catalog"}/${chatId}`;
  };
  async function writeCatalogEntry(chatId: string, descriptor: ConversationAttachment) {
    conversationPath(chatId, descriptor.id);
    const saved = await objects.upload(`${catalogPrefix(chatId)}/${descriptor.id}.json`, JSON.stringify(descriptor), { contentType: "application/json", upsert: true });
    if (saved.error) throw new Error("Unable to save the attachment discovery index.");
    if (descriptor.actorId) {
      const indexed = await objects.upload(`${catalogPrefix(descriptor.actorId, "actor")}/${descriptor.id}.json`, JSON.stringify(descriptor), { contentType: "application/json", upsert: true });
      if (indexed.error) throw new Error("Unable to index attachment across actor conversations.");
    }
  }
  return {
    // Authenticated by the same short-lived HMAC ticket as the original signed upload.
    // A client can only write bounded chunks to its own randomly generated incoming path.
    async uploadChunk(token: string, index: number, bytes: Uint8Array, subIndex?: number) {
      const startedAtMs = Date.now();
      const ticket = verify(token, "upload");
      const chunkBytes = chunkBytesFor(ticket);
      const chunkCount = Math.ceil(ticket.size / chunkBytes);
      if (!Number.isSafeInteger(index) || index < 0 || index >= chunkCount) {
        throw new UploadInputError("Invalid attachment chunk index.");
      }
      const expected = Math.min(chunkBytes, ticket.size - index * chunkBytes);
      const useSubChunk = subIndex !== undefined;
      let expectedBytes = expected;
      if (useSubChunk) {
        if (ticket.transport !== "json-base64-v2" || !Number.isSafeInteger(subIndex) ||
            subIndex < 0 || subIndex >= Math.ceil(expected / UPLOAD_JSON_SMALL_CHUNK_BYTES)) {
          throw new UploadInputError("Invalid legacy video sub-chunk.");
        }
        expectedBytes = Math.min(UPLOAD_JSON_SMALL_CHUNK_BYTES,
          expected - subIndex! * UPLOAD_JSON_SMALL_CHUNK_BYTES);
      }
      if (bytes.byteLength !== expectedBytes) {
        throw new UploadInputError(`Attachment chunk ${index + 1}/${chunkCount} has the wrong size.`);
      }
      await ensureBucket();
      const path = useSubChunk ? subChunkPath(ticket, index, subIndex!) : chunkPath(ticket, index);
      const { error } = await objects.upload(path, bytes, {
        contentType: "application/octet-stream",
        upsert: true, // Retry after a mobile network interruption without duplicating bytes.
      });
      if (error) throw new Error(`Unable to store attachment chunk ${index + 1}: ${error.message}`);
      console.info("[Upload API] stored chunk", {
        uploadId: ticket.id, index, ...(useSubChunk ? { subIndex } : {}), chunkCount,
        bytes: bytes.byteLength, transport: ticket.transport ?? "binary-v1",
        storageWriteMs: Date.now() - startedAtMs
      });
      return { index, ...(useSubChunk ? { subIndex } : {}), chunkCount,
        uploadedBytes: (index * chunkBytes) + (useSubChunk ? subIndex! * UPLOAD_JSON_SMALL_CHUNK_BYTES : 0) + bytes.byteLength };
    },
    // Only a valid HMAC-signed ticket can inspect this upload's chunk progress.
    async chunkStatus(token: string) {
      const ticket = verify(token, "upload");
      await ensureBucket();
      const chunkBytes = chunkBytesFor(ticket);
      const chunkCount = Math.ceil(ticket.size / chunkBytes);
      const completed = await objects.download(referencePath(ticket));
      if (completed.data) {
        return { uploadId: ticket.id, chunkCount, chunkBytes, transport: ticket.transport ?? "binary-v1", uploadedIndexes: Array.from({ length: chunkCount }, (_, index) => index), complete: true };
      }
      const source = await objects.download(sourcePath(ticket));
      if (source.data?.size === ticket.size) {
        return { uploadId: ticket.id, chunkCount, chunkBytes, transport: ticket.transport ?? "binary-v1", uploadedIndexes: Array.from({ length: chunkCount }, (_, index) => index), complete: false };
      }
      // Paginate; a 200 MB v3 video can contain 400 accepted chunks.
      // Restrict to this signed ticket's UUID so uploads cannot inspect each other.
      const uploaded = new Set<number>();
      const uploadedSubParts = new Set<number>();
      const potentialStoredEntries = chunkCount +
        (ticket.transport === "json-base64-v2" ? Math.ceil(ticket.size / UPLOAD_JSON_SMALL_CHUNK_BYTES) : 0);
      for (let offset = 0; offset <= potentialStoredEntries; offset += 100) {
        const listed = await objects.list("chunks", { limit: 100, offset, search: ticket.id });
        if (listed.error) throw new Error("Unable to check saved video upload progress.");
        for (const entry of listed.data ?? []) {
          const expectedPrefix = ticket.id + "-";
          if (!entry.name.startsWith(expectedPrefix)) continue;
          const suffix = entry.name.slice(expectedPrefix.length);
          const match = /^([0-9]{3})(?:-sub-([0-9]{3}))?$/.exec(suffix);
          if (!match) continue;
          const index = Number(match[1]);
          if (index < 0 || index >= chunkCount) continue;
          const expected = Math.min(chunkBytes, ticket.size - index * chunkBytes);
          const size = entry.metadata?.size;
          if (match[2] !== undefined) {
            if (ticket.transport !== "json-base64-v2") continue;
            const part = Number(match[2]);
            if (part >= Math.ceil(expected / UPLOAD_JSON_SMALL_CHUNK_BYTES)) continue;
            const expectedPartSize = Math.min(UPLOAD_JSON_SMALL_CHUNK_BYTES,
              expected - part * UPLOAD_JSON_SMALL_CHUNK_BYTES);
            if (size != null && Number(size) !== expectedPartSize) continue;
            uploadedSubParts.add(index * 4 + part);
          } else {
            if (size != null && Number(size) !== expected) continue;
            uploaded.add(index);
          }
        }
        if ((listed.data ?? []).length < 100) break;
      }
      const uploadedIndexes = [...uploaded].sort((a, b) => a - b);
      const uploadedSubIndexes = [...uploadedSubParts].sort((a, b) => a - b);
      console.info("[Upload API] upload resume status", {
        uploadId: ticket.id, completedChunks: uploadedIndexes.length,
        completedSubChunks: uploadedSubIndexes.length,
        chunkCount, transport: ticket.transport ?? "binary-v1"
      });
      return { uploadId: ticket.id, chunkCount, chunkBytes,
        transport: ticket.transport ?? "binary-v1", uploadedIndexes, uploadedSubIndexes, complete: false };
    },
    async catalog(chatId: string, scope: "chat" | "actor" = "chat"): Promise<{ initialized: boolean; attachments: ConversationAttachment[] }> {
      await ensureBucket();
      const prefix = catalogPrefix(chatId, scope);
      const result: ConversationAttachment[] = [];
      let initialized = false;
      for (let offset = 0; ; offset += 100) {
        const listed = await objects.list(prefix, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
        if (listed.error) throw new Error("Unable to read saved attachment index.");
        const entries = listed.data ?? [];
        initialized ||= entries.some(entry => entry.name === "initialized.json");
        const records = entries.filter(entry => /^[0-9a-f-]{36}\.json$/i.test(entry.name));
        for (let i = 0; i < records.length; i += 10) {
          const loaded = await Promise.all(records.slice(i, i + 10).map(async entry => {
            const file = await objects.download(`${prefix}/${entry.name}`);
            if (file.error || !file.data) throw new Error("Saved attachment index entry is unavailable.");
            const record = JSON.parse(await file.data.text()) as ConversationAttachment;
            conversationPath(chatId, record.id);
            return record;
          }));
          result.push(...loaded);
        }
        if (entries.length < 100) break;
      }
      return { initialized, attachments: result };
    },
    async initializeCatalog(chatId: string, attachments: ConversationAttachment[], scope: "chat" | "actor" = "chat") {
      await ensureBucket();
      for (const descriptor of attachments) {
        if (scope === "actor") {
          if (!descriptor.chatId) throw new UploadInputError("Missing source conversation.");
          await writeCatalogEntry(descriptor.chatId, { ...descriptor, actorId: chatId });
        } else if (!descriptor.chatId || descriptor.chatId === chatId) await writeCatalogEntry(chatId, descriptor);
      }
      const result = await objects.upload(`${catalogPrefix(chatId, scope)}/initialized.json`, "{}", { contentType: "application/json", upsert: true });
      if (result.error) throw new Error("Unable to initialize attachment discovery.");
    },
    async persist(chatId: string, reference: FileReference, token?: string, options: { source?: Blob; description?: Partial<ConversationAttachment>; actorId?: string } = {}): Promise<ConversationAttachment> {
      await ensureBucket();
      const id = randomUUID();
      const path = conversationPath(chatId, id);
      let source = options.source;
      if (token) {
        const ticket = verify(token, "reference");
        const downloaded = await objects.download(sourcePath(ticket));
        source = downloaded.data ?? undefined;
      }
      const hasSource = Boolean(source);
      if (source) {
        const saved = await objects.upload(`${path}.source`, source, { contentType: reference.mimeType, upsert: true });
        if (saved.error) throw new Error("Unable to retain the original attachment for future questions.");
      }
      const saved = await objects.upload(`${path}.json`, JSON.stringify({ reference, hasSource, actorId: options.actorId, refreshedAt: now() }), { contentType: "application/json", upsert: true });
      if (saved.error) throw new Error("Unable to retain this attachment for follow-up questions.");
      const descriptor: ConversationAttachment = { ...options.description, id, fileName: reference.fileName, mimeType: reference.mimeType, createdAt: new Date(now()).toISOString(), hasOriginal: hasSource, chatId, actorId: options.actorId };
      await writeCatalogEntry(chatId, descriptor);
      return descriptor;
    },
    async restore(chatId: string, attachment: ConversationAttachment, expectedActorId?: string): Promise<FileReference> {
      const path = conversationPath(chatId, attachment.id);
      const stored = await objects.download(`${path}.json`);
      if (stored.error || !stored.data) throw new UploadInputError("The saved attachment is unavailable.");
      const record = JSON.parse(await stored.data.text()) as { reference: FileReference; hasSource: boolean; refreshedAt: number; actorId?: string };
      if (expectedActorId && record.actorId && record.actorId !== expectedActorId) throw new UploadInputError("This file belongs to a different actor.");
      if (!record.reference.imageDataUrl && now() - record.refreshedAt >= RETENTION_MS) {
        const source = record.hasSource ? await objects.download(`${path}.source`) : null;
        if (!source?.data) {
          if (record.reference.extractedText && !record.reference.mimeType.startsWith("video/")) return { ...record.reference, providerRef: undefined };
          throw new UploadInputError("The source reference has expired; please attach the file again.");
        }
        const [renewed] = await buildReferences([new File([source.data], record.reference.fileName, { type: record.reference.mimeType })]);
        if (!renewed || (record.reference.mimeType.startsWith("video/") && !renewed.providerRef?.googleFileUri)) throw new UploadInputError("Unable to restore source access.");
        record.reference = { ...renewed, videoFrames: record.reference.videoFrames };
        record.refreshedAt = now();
        const updated = await objects.upload(`${path}.json`, JSON.stringify(record), { contentType: "application/json", upsert: true });
        if (updated.error) throw new Error("Unable to save renewed video access.");
      }
      return record.reference;
    },
    // Recover visual evidence only after Gemini fails. This reads the original
    // video already saved for this actor and persists extracted frames privately
    // for every subsequent retry, without asking for another upload.
    async recoverSavedVideoFrames(
      chatId: string, attachment: ConversationAttachment, expectedActorId: string,
      extract: typeof extractFramesFromPrivateVideo = extractFramesFromPrivateVideo,
    ): Promise<FileReference> {
      if (attachment.chatId && attachment.chatId !== chatId) throw new UploadInputError("Video attachment belongs to another conversation.");
      if (attachment.actorId && attachment.actorId !== expectedActorId) throw new UploadInputError("Video attachment belongs to another actor.");
      const path = conversationPath(chatId, attachment.id);
      const stored = await objects.download(`${path}.json`);
      if (stored.error || !stored.data) throw new UploadInputError("Previously saved video details are unavailable.");
      const record = JSON.parse(await stored.data.text()) as {
        reference: FileReference; hasSource: boolean; refreshedAt: number; actorId?: string
      };
      if (record.actorId && record.actorId !== expectedActorId) throw new UploadInputError("Video belongs to another actor.");
      if (!record.reference.mimeType.startsWith("video/")) throw new UploadInputError("Saved attachment is not a video.");
      if (record.reference.videoFrames?.length) return record.reference;
      if (!record.hasSource) throw new UploadInputError("Original video was not retained; cannot extract real frames.");
      const original = await objects.download(`${path}.source`);
      if (original.error || !original.data) throw new UploadInputError("The original saved video is no longer available.");
      const frames = validateVideoFallbackFrames(await extract(original.data));
      if (!frames.length) throw new UploadInputError("Server decoded no video frames; Grok visual fallback is unavailable.");
      record.reference.videoFrames = frames;
      const saved = await objects.upload(`${path}.json`, JSON.stringify(record), {
        contentType: "application/json", upsert: true
      });
      if (saved.error) throw new Error("Unable to persist recovered video frames.");
      console.info("[Video Routing] saved video frames recovered", {
        attachmentId: attachment.id, frameCount: frames.length, source: "saved-conversation"
      });
      return record.reference;
    },
    async recoverUploadVideoFrames(
      referenceToken: string,
      extract: typeof extractFramesFromPrivateVideo = extractFramesFromPrivateVideo,
    ): Promise<FileReference> {
      const ticket = verify(referenceToken, "reference");
      if (!ticket.type.startsWith("video/")) throw new UploadInputError("Signed attachment is not a video.");
      const stored = await objects.download(referencePath(ticket));
      if (stored.error || !stored.data) throw new UploadInputError("Uploaded video reference is unavailable.");
      const reference = JSON.parse(await stored.data.text()) as FileReference;
      if (reference.videoFrames?.length) return reference;
      const original = await objects.download(sourcePath(ticket));
      if (original.error || !original.data) throw new UploadInputError("The uploaded original video is unavailable.");
      const frames = validateVideoFallbackFrames(await extract(original.data));
      if (!frames.length) throw new UploadInputError("Server decoded no video frames; Grok visual fallback is unavailable.");
      reference.videoFrames = frames;
      const saved = await objects.upload(referencePath(ticket), JSON.stringify(reference), {
        contentType: "application/json", upsert: true
      });
      if (saved.error) throw new Error("Unable to persist recovered video frames.");
      console.info("[Video Routing] uploaded video frames recovered", {
        uploadId: ticket.id, frameCount: frames.length, source: "signed-upload"
      });
      return reference;
    },
    async removeConversation(chatId: string, actorId?: string) {
      if (!z.string().uuid().safeParse(chatId).success) return;
      const ownFileIds: string[] = [];
      for (const prefix of [`chats/${chatId}`, catalogPrefix(chatId)]) {
      for (;;) {
        const listed = await objects.list(prefix, { limit: 100 });
        if (listed.error) throw new Error("Unable to list conversation attachments for deletion.");
        if (!listed.data?.length) break;
        if (prefix === catalogPrefix(chatId)) ownFileIds.push(...listed.data.filter(item => /^[0-9a-f-]{36}\.json$/i.test(item.name)).map(item => item.name));
        const removed = await objects.remove(listed.data.map(item => `${prefix}/${item.name}`));
        if (removed.error) throw new Error("Unable to delete conversation attachments.");
      }
      }
      if (actorId && ownFileIds.length) {
        for (let i = 0; i < ownFileIds.length; i += 100) {
          const removed = await objects.remove(ownFileIds.slice(i, i + 100).map(name => `${catalogPrefix(actorId, "actor")}/${name}`));
          if (removed.error) throw new Error("Unable to remove actor attachment index entries.");
        }
      }
    },
    async removeActorIndex(actorId: string) {
      const prefix = catalogPrefix(actorId, "actor");
      for (;;) {
        const listed = await objects.list(prefix, { limit: 100 });
        if (listed.error) throw new Error("Unable to list actor attachment index.");
        if (!listed.data?.length) return;
        const removed = await objects.remove(listed.data.map(item => `${prefix}/${item.name}`));
        if (removed.error) throw new Error("Unable to delete actor attachment index.");
      }
    },
    async prepare(input: unknown) {
      const parsed = uploadMetadataSchema.safeParse(input);
      if (!parsed.success) throw new UploadInputError("Invalid attachment name, type, or size (maximum 200 MB).");
      const metadata = parsed.data;
      try { validateUploadFiles([metadata as File]); }
      catch (error) { throw new UploadInputError(error instanceof Error ? error.message : "Invalid attachment."); }
      await ensureBucket();
      await cleanExpiredObjects();
      const ticket: Ticket = { ...metadata, id: randomUUID(), kind: "upload", expires: now() + 2 * 60 * 60 * 1000 };
      const signed = await objects.createSignedUploadUrl(sourcePath(ticket));
      if (signed.error || !signed.data) throw new Error("Unable to authorize attachment upload. Please try again.");
      console.info("[Upload API] prepared", { uploadId: ticket.id, bytes: ticket.size, mimeType: ticket.type, transport: ticket.transport ?? "binary-v1" });
      return { uploadUrl: signed.data.signedUrl, uploadToken: sign(ticket), uploadId: ticket.id };
    },
    async complete(token: string, rawVideoFrames?: unknown): Promise<FileReference> {
      const ticket = verify(token, "upload");
      const videoFrames = ticket.type.startsWith("video/") ? validateVideoFallbackFrames(rawVideoFrames) : [];
      const cached = await objects.download(referencePath(ticket));
      if (cached.data) return compact(JSON.parse(await cached.data.text()) as FileReference, ticket);
      const source = await objects.download(sourcePath(ticket));
      let sourceBlob: Blob | null = source.data ?? null;
      if (!sourceBlob) {
        // Mobile-safe relay: gather verified same-origin chunks only after all are present.
        // Keep the original intact for conversation persistence and future video replay.
        const chunkBytes = chunkBytesFor(ticket);
        const chunkCount = Math.ceil(ticket.size / chunkBytes);
        const blobs: Blob[] = [];
        const chunkPaths: string[] = [];
        // Bounded parallel reads keep 40+ small chunks from making finalization
        // unnecessarily slow. Store parts in index order to preserve exact bytes.
        for (let start = 0; start < chunkCount; start += 6) {
          const end = Math.min(chunkCount, start + 6);
          const parts = await Promise.all(Array.from({ length: end - start }, async (_, offset) => {
            const index = start + offset;
            const path = chunkPath(ticket, index);
            const part = await objects.download(path);
            const expected = Math.min(chunkBytes, ticket.size - index * chunkBytes);
            if (!part.error && part.data && part.data.size === expected) {
              return { paths: [path], blob: part.data };
            }
            // If a legacy 2 MiB receipt has not got this whole chunk, it may
            // have been completed as 512 KiB sub-chunks on a newer client.
            if (ticket.transport === "json-base64-v2") {
              const subCount = Math.ceil(expected / UPLOAD_JSON_SMALL_CHUNK_BYTES);
              const recovered = await Promise.all(Array.from({ length: subCount }, async (_, subIndex) => {
                const subPath = subChunkPath(ticket, index, subIndex);
                const sub = await objects.download(subPath);
                const expectedSub = Math.min(UPLOAD_JSON_SMALL_CHUNK_BYTES,
                  expected - subIndex * UPLOAD_JSON_SMALL_CHUNK_BYTES);
                if (sub.error || !sub.data || sub.data.size !== expectedSub) return null;
                return { path: subPath, blob: sub.data };
              }));
              if (recovered.every((entry): entry is { path: string; blob: Blob } => entry !== null)) {
                return { paths: recovered.map(entry => entry.path),
                  blob: new Blob(recovered.map(entry => entry.blob)) };
              }
            }
            if (index === 0 && !part.data) {
              throw new UploadInputError("The file upload did not finish. Please attach the file again.");
            }
            throw new UploadInputError(`The file upload stopped at chunk ${index + 1}/${chunkCount}. Please retry the upload.`);
          }));
          for (const part of parts) {
            blobs.push(part.blob);
            chunkPaths.push(...part.paths);
          }
        }
        const merged = new Blob(blobs, { type: ticket.type || "application/octet-stream" });
        if (merged.size !== ticket.size) {
          throw new UploadInputError("The assembled attachment does not match its original size.");
        }
        const saved = await objects.upload(sourcePath(ticket), merged, {
          contentType: ticket.type || "application/octet-stream",
          upsert: true,
        });
        if (saved.error) throw new Error(`Unable to finalize the uploaded file: ${saved.error.message}`);
        sourceBlob = merged;
        const cleanup = await objects.remove(chunkPaths);
        if (cleanup.error) console.warn("[Upload API] unable to remove finalized upload chunks", { chunkCount });
      }
      if (sourceBlob.size !== ticket.size) {
        await objects.remove([sourcePath(ticket)]);
        throw new UploadInputError("The uploaded file size does not match the original. Please attach the file again.");
      }
      const file = new File([sourceBlob], ticket.name, { type: ticket.type });
      const [reference] = await buildReferences([file]);
      if (!reference) throw new Error("Attachment processing returned no file reference.");
      if (videoFrames.length) reference.videoFrames = videoFrames;
      console.info("[Upload API] captured video fallback evidence", { uploadId: ticket.id, frameCount: videoFrames.length });
      const stored = await objects.upload(referencePath(ticket), JSON.stringify(reference), {
        contentType: "application/json", upsert: true,
      });
      if (stored.error) throw new Error("Unable to save the processed attachment. Please try again.");
      // Keep every original until it is linked to a chat; abandoned uploads expire after 24 hours.
      console.info("[Upload API] direct upload processed", { fileName: ticket.name, bytes: ticket.size, attachmentKind: reference.attachmentKind });
      return compact(reference, ticket);
    },
    async hydrate(references: FileReference[]): Promise<FileReference[]> {
      if (references.length > 5) throw new UploadInputError("Too many files. Maximum allowed is 5.");
      const hydrated: FileReference[] = [];
      for (const reference of references) {
        if (!reference.storageToken) { hydrated.push(reference); continue; }
        const ticket = verify(reference.storageToken, "reference");
        const stored = await objects.download(referencePath(ticket));
        if (stored.error || !stored.data) throw new UploadInputError("The stored attachment is unavailable. Please attach the file again.");
        // Only the server-written reference is trusted, never client-supplied provider IDs or text.
        hydrated.push(JSON.parse(await stored.data.text()) as FileReference);
      }
      return hydrated;
    },
  };
}

function getUploadService() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Attachment storage is not configured.");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(180_000) }) },
  });
  return createStoredUploadService(client.storage, key);
}

export const prepareStoredUpload = (input: unknown) => getUploadService().prepare(input);
export const completeStoredUpload = (token: string, videoFrames?: unknown) => getUploadService().complete(token, videoFrames);
export const uploadStoredChunk = (token: string, index: number, bytes: Uint8Array, subIndex?: number) => getUploadService().uploadChunk(token, index, bytes, subIndex);
export const getStoredUploadChunkStatus = (token: string) => getUploadService().chunkStatus(token);
export const hydrateStoredAttachments = (references: FileReference[]) =>
  references.some(reference => reference.storageToken) ? getUploadService().hydrate(references) : Promise.resolve(references);

export const persistConversationAttachment = (chatId: string, reference: FileReference, token?: string, options?: { source?: Blob; description?: Partial<ConversationAttachment>; actorId?: string }) => getUploadService().persist(chatId, reference, token, options);
export const restoreConversationAttachment = (chatId: string, attachment: ConversationAttachment, actorId?: string) => getUploadService().restore(chatId, attachment, actorId);
export const recoverSavedVideoFrames = (chatId: string, attachment: ConversationAttachment, actorId: string) => getUploadService().recoverSavedVideoFrames(chatId, attachment, actorId);
export const recoverUploadVideoFrames = (referenceToken: string) => getUploadService().recoverUploadVideoFrames(referenceToken);
export const removeConversationAttachments = (chatId: string, actorId?: string) => getUploadService().removeConversation(chatId, actorId);
export const removeActorAttachmentIndex = (actorId: string) => getUploadService().removeActorIndex(actorId);

export async function loadConversationAttachmentCatalog(chatId: string, legacyLoader: () => Promise<ConversationAttachment[]>): Promise<ConversationAttachment[]> {
  const service = getUploadService();
  const catalog = await service.catalog(chatId);
  if (catalog.initialized) return catalog.attachments;
  const combined = [...new Map([...(await legacyLoader()), ...catalog.attachments].map(file => [file.id, file])).values()];
  await service.initializeCatalog(chatId, combined);
  return combined;
}

export async function loadActorAttachmentCatalog(actorId: string, legacyLoader: () => Promise<ConversationAttachment[]>): Promise<ConversationAttachment[]> {
  const service = getUploadService();
  const catalog = await service.catalog(actorId, "actor");
  if (catalog.initialized) return catalog.attachments.filter(file => file.actorId === actorId);
  const combined = [...new Map([...(await legacyLoader()), ...catalog.attachments].map(file => [file.id, { ...file, actorId }])).values()];
  await service.initializeCatalog(actorId, combined, "actor");
  return combined;
}
