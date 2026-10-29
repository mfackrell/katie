import { inspectPdf, type PdfEvidence } from "./pdf-evidence";
import { formatVideoTimingForSource } from "@/lib/chat/video-evidence";
import { indexEvidence, indexReference } from "@/lib/media-memory/evidence";
import { getVideoTiming, registerVideoTiming, type VideoTiming } from "./video-timing";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ConversationAttachment } from "@/lib/chat/attachment-continuity";
import type { FileReference } from "@/lib/providers/types";
import { buildFileReferences, validateUploadFiles } from "./build-file-references";
import { MAX_VIDEO_FALLBACK_FRAMES, VIDEO_FRAME_SAMPLE_VERSION, validateVideoFallbackFrames, type VideoFallbackFrame } from "./video-fallback-frames";
import { extractFramesFromPrivateVideo } from "./server-video-frame-recovery";
import { recordCompletedHandoffUpload } from "./video-handoffs";

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
  indexSaved?: typeof indexReference;
} = {}) {
  const now = options.now ?? Date.now;
  const buildReferences = options.buildReferences ?? buildFileReferences;
  const indexSaved = options.indexSaved;
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
  const processingPath = (ticket: Ticket) => `processing/${ticket.id}.json`;
  type ProcessingRecord = { status: "processing" | "failed"; startedAt: number; error?: string };
  const processingStaleMs = 5 * 60 * 1000;
  const readProcessingRecord = async (ticket: Ticket): Promise<ProcessingRecord | null> => {
    const entry = await objects.download(processingPath(ticket));
    if (!entry.data) return null;
    try {
      const value = JSON.parse(await entry.data.text()) as ProcessingRecord;
      if ((value.status === "processing" || value.status === "failed") &&
          Number.isFinite(value.startedAt)) return value;
    } catch { /* Invalid status cannot be trusted. */ }
    return null;
  };
  const compact = (reference: FileReference, ticket: Ticket): FileReference => {
    const metadata = { ...reference };
    delete metadata.pdfInventory;
    delete metadata.pdfEvidence;
    delete metadata.extractedText;
    delete metadata.extractedChunks;
    delete metadata.imageDataUrl;
    delete (metadata as FileReference & { decoderTiming?: unknown }).decoderTiming;
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
    for (const prefix of ["incoming", "references", "chunks", "processing"]) {
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
    async ingestPdfUploads(files:File[]):Promise<FileReference[]> {
      const references=await buildReferences(files);
      if(references.some(reference=>reference.mimeType==="application/pdf")) {
        await ensureBucket();
        await cleanExpiredObjects();
      }
      return Promise.all(references.map(async (reference,index)=>{
        if(reference.mimeType!=="application/pdf") return reference;
        await ensureBucket();
        const file=files[index];
        const ticket:Ticket={id:randomUUID(),kind:"upload",name:file.name,type:reference.mimeType,size:file.size,expires:now()+2*60*60*1000};
        const source=await objects.upload(sourcePath(ticket),file,{contentType:reference.mimeType,upsert:false});
        if(source.error) throw new Error("Unable to retain PDF original.");
        const saved=await objects.upload(referencePath(ticket),JSON.stringify(reference),{contentType:"application/json",upsert:false});
        if(saved.error) throw new Error("Unable to retain PDF reference.");
        return compact(reference,ticket);
      }));
    },
    inspectUpload(token: string) {
      const ticket = verify(token, "upload");
      return { uploadId: ticket.id, name: ticket.name,
        type: ticket.type, size: ticket.size };
    },
    /** Operator-only restoration for uploads made before durable registration existed.
     *  Never expose this function to a public route: old uploads have no actor owner.
     */
    async recoverUnlinkedVideo(uploadId: string): Promise<FileReference> {
      if (!z.string().uuid().safeParse(uploadId).success) {
        throw new UploadInputError("Invalid legacy upload ID.");
      }
      const stored = await objects.download(`references/${uploadId}.json`);
      if (stored.error || !stored.data) throw new UploadInputError("Legacy video reference is unavailable.");
      const reference = JSON.parse(await stored.data.text()) as FileReference;
      if (reference.attachmentKind !== "video" || !reference.mimeType?.startsWith("video/")) {
        throw new UploadInputError("Legacy source was not a video.");
      }
      const source = await objects.download(`incoming/${uploadId}`);
      if (source.error || !source.data || source.data.size < 1 || source.data.size > 200 * 1024 * 1024) {
        throw new UploadInputError("Original legacy video is unavailable.");
      }
      const ticket: Ticket = {
        id: uploadId, kind: "upload", name: reference.fileName,
        type: reference.mimeType, size: source.data.size,
        expires: now() + 2 * 60 * 60 * 1000,
      };
      // HMAC reference proves to /api/chat that it may persist the privately
      // retained original into the operator-specified actor's conversation.
      return compact(reference, ticket);
    },
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
    // Signed, private direct-to-Supabase multipart upload URLs avoid putting
    // Base64 bodies through Vercel. All file paths are derived from the HMAC
    // ticket and bounded indexes, never from client-supplied paths.
    async signDirectChunks(token: string, entries: Array<{ index: number; subIndex?: number }>) {
      const ticket = verify(token, "upload");
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 50) {
        throw new UploadInputError("Request 1 to 50 upload URLs at a time.");
      }
      const chunkBytes = chunkBytesFor(ticket);
      const chunkCount = Math.ceil(ticket.size / chunkBytes);
      const unique = new Set<string>();
      const parsed = entries.map(entry => {
        const index = entry?.index;
        const subIndex = entry?.subIndex;
        if (!Number.isSafeInteger(index) || index < 0 || index >= chunkCount) {
          throw new UploadInputError("Invalid signed upload chunk index.");
        }
        const expectedSize = Math.min(chunkBytes, ticket.size - index * chunkBytes);
        if (subIndex !== undefined && (
          ticket.transport !== "json-base64-v2" ||
          !Number.isSafeInteger(subIndex) || subIndex < 0 ||
          subIndex >= Math.ceil(expectedSize / UPLOAD_JSON_SMALL_CHUNK_BYTES)
        )) {
          throw new UploadInputError("Invalid signed upload sub-chunk index.");
        }
        const key = `${index}:${subIndex ?? "whole"}`;
        if (unique.has(key)) throw new UploadInputError("Duplicate signed upload chunk index.");
        unique.add(key);
        return {
          index, ...(subIndex === undefined ? {} : { subIndex }),
          path: subIndex === undefined ? chunkPath(ticket, index) : subChunkPath(ticket, index, subIndex),
        };
      });
      await ensureBucket();
      const urls: Array<{ index: number; subIndex?: number; signedUrl: string }> = [];
      // Bounded parallel requests; signing is quick and never transfers bytes
      // through Katie's functions.
      for (let start = 0; start < parsed.length; start += 6) {
        const signed = await Promise.all(parsed.slice(start, start + 6).map(async entry => {
          const result = await objects.createSignedUploadUrl(entry.path, { upsert: true });
          if (result.error || !result.data?.signedUrl) {
            throw new Error("Unable to authorize private direct video upload.");
          }
          return {
            index: entry.index,
            ...(entry.subIndex === undefined ? {} : { subIndex: entry.subIndex }),
            signedUrl: result.data.signedUrl,
          };
        }));
        urls.push(...signed);
      }
      console.info("[Upload API] private direct upload URLs issued", {
        uploadId: ticket.id, chunkCount: urls.length, transport: ticket.transport ?? "binary-v1",
      });
      return { uploadId: ticket.id, transport: ticket.transport ?? "binary-v1", urls };
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
        return { uploadId: ticket.id, chunkCount, chunkBytes, transport: ticket.transport ?? "binary-v1", uploadedIndexes: Array.from({ length: chunkCount }, (_, index) => index), complete: true };
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
        transport: ticket.transport ?? "binary-v1", uploadedIndexes, uploadedSubIndexes,
        complete: Array.from({ length: chunkCount }, (_, index) => {
          if (uploaded.has(index)) return true;
          if (ticket.transport !== "json-base64-v2") return false;
          const expected = Math.min(chunkBytes, ticket.size - index * chunkBytes);
          return Array.from({ length: Math.ceil(expected / UPLOAD_JSON_SMALL_CHUNK_BYTES) },
            (_, sub) => uploadedSubParts.has(index * 4 + sub)).every(Boolean);
        }).every(Boolean) };
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
      // HMAC-bearing uploads use the private server-written canonical reference.
      const privateEntry = token ? await objects.download(referencePath(verify(token, "reference"))) : null;
      if (token && !privateEntry?.data) throw new UploadInputError("Stored evidence is unavailable.");
      const safeReference: FileReference = privateEntry?.data ? JSON.parse(await privateEntry.data.text()) : { ...reference };
      delete (safeReference as FileReference & { decoderTiming?: unknown }).decoderTiming;
      const decoderTiming = getVideoTiming(reference);
      const descriptor: ConversationAttachment = { ...options.description, id, fileName: reference.fileName, mimeType: reference.mimeType, createdAt: new Date(now()).toISOString(), hasOriginal: hasSource, chatId, actorId: options.actorId };
      const sourceFingerprint = source && reference.mimeType.startsWith("video/") ? createHash("sha256").update(Buffer.from(await source.arrayBuffer())).digest("hex") : undefined;
      const canonical = { sourceFingerprint, reference: safeReference, decoderTiming, hasSource, actorId: options.actorId, refreshedAt: now(), evidenceDescriptor: descriptor, evidenceIndexPending: Boolean(indexSaved && options.actorId && (token || options.source)) };
      const saved = await objects.upload(`${path}.json`, JSON.stringify(canonical), { contentType: "application/json", upsert: true });
      if (saved.error) throw new Error("Unable to retain this attachment for follow-up questions.");
      await writeCatalogEntry(chatId, descriptor);
      // Durable retry marker is canonical private storage, not a process-local queue.
      if (indexSaved && options.actorId && (token || options.source)) {
        try {
          const queued = await objects.upload(`evidence-pending/${options.actorId}/${id}.json`, JSON.stringify(descriptor), { contentType: "application/json", upsert: true });
          if (queued.error) console.warn("[Media memory] durable retry registration unavailable");
          const progress = await indexSaved(descriptor, safeReference);
          if (progress && !progress.complete) {
            const advanced = await objects.upload(`evidence-pending/${options.actorId}/${id}.json`, JSON.stringify({...descriptor,evidenceNextPart:progress.nextPart}), {contentType:"application/json",upsert:true});
            if (advanced.error) throw new Error("Evidence progress deferred");
            return descriptor;
          }
          if (decoderTiming) await indexEvidence(descriptor, "timing", "server-timing-v1", formatVideoTimingForSource(decoderTiming, {fileName:descriptor.fileName,fileId:id,ordinal:1}), "server measured");
          const acknowledged = await objects.upload(`${path}.json`, JSON.stringify({...canonical,evidenceIndexPending:false}), {contentType:"application/json",upsert:true});
          if (acknowledged.error) throw new Error("Evidence acknowledgment deferred");
          await objects.remove([`evidence-pending/${options.actorId}/${id}.json`]);
        } catch { console.warn("[Media memory] indexing deferred"); }
      }
      return descriptor;
    },
    async retryEvidence(actorId: string, owns: (chatId: string) => Promise<boolean>, catalog: ConversationAttachment[] = []) {
      if (!indexSaved) return;
      const prefix = catalogPrefix(actorId, "actor").replace("actor-catalog/", "evidence-pending/");
      // One rotating canonical check also repairs a failed pending-marker write.
      // Only future records with an explicit durable pending bit are eligible.
      const statePath=`evidence-repair-state/${actorId}.json`;
      const state=await objects.download(statePath);
      let cursor="";
      try { if(state.data) cursor=JSON.parse(await state.data.text()).cursor ?? ""; } catch { /* Restart at first eligible key. */ }
      const candidates=catalog.filter(file=>file.actorId===actorId && file.chatId).sort((a,b)=>`${a.chatId}/${a.id}`.localeCompare(`${b.chatId}/${b.id}`));
      const candidate=candidates.find(file=>`${file.chatId}/${file.id}`>cursor) ?? candidates[0];
      if(candidate && await owns(candidate.chatId!)) {
        const record=await objects.download(`${conversationPath(candidate.chatId!,candidate.id)}.json`);
        if(record.data) {
          try {
            const canonical=JSON.parse(await record.data.text());
            if(canonical.actorId===actorId && canonical.evidenceIndexPending && canonical.evidenceDescriptor?.id===candidate.id && canonical.evidenceDescriptor?.chatId===candidate.chatId) {
              // Repair only a missing marker; never reset a live upload's part cursor.
              const marker = await objects.download(`${prefix}/${candidate.id}.json`);
              if (!marker.data) await objects.upload(`${prefix}/${candidate.id}.json`,JSON.stringify(canonical.evidenceDescriptor),{contentType:"application/json",upsert:true});
            }
          } catch { console.warn("[Media memory] canonical repair deferred"); }
        }
        await objects.upload(statePath,JSON.stringify({cursor:`${candidate.chatId}/${candidate.id}`}),{contentType:"application/json",upsert:true});
      }
      const pending = await objects.list(prefix, { limit: 3, sortBy: { column: "updated_at", order: "asc" } });
      for (const entry of pending.data ?? []) {
        const path = `${prefix}/${entry.name}`;
        const stored = await objects.download(path);
        if (!stored.data) continue;
        try {
          const file = JSON.parse(await stored.data.text()) as ConversationAttachment & {evidenceNextPart?:number};
          if (file.actorId !== actorId || !file.chatId || !await owns(file.chatId)) {
            await objects.remove([path]); continue;
          }
          const canonical = await objects.download(`${conversationPath(file.chatId, file.id)}.json`);
          if (!canonical.data) throw new Error("Saved evidence temporarily unavailable");
          const record = JSON.parse(await canonical.data.text());
          if (record.actorId !== actorId) continue;
          const progress = await indexSaved(file, record.reference, file.evidenceNextPart ?? 0);
          if (progress && !progress.complete) {
            const advanced = await objects.upload(path,JSON.stringify({...file,evidenceNextPart:progress.nextPart}),{contentType:"application/json",upsert:true});
            if (advanced.error) throw new Error("Evidence progress deferred");
            continue;
          }
          if (record.decoderTiming) {
            registerVideoTiming(record.reference, record.decoderTiming);
            const timing=getVideoTiming(record.reference);
            if(timing) await indexEvidence(file,"timing","server-timing-v1",formatVideoTimingForSource(timing,{fileName:file.fileName,fileId:file.id,ordinal:1}),"server measured");
          }
          const acknowledged=await objects.upload(`${conversationPath(file.chatId,file.id)}.json`,JSON.stringify({...record,evidenceIndexPending:false}),{contentType:"application/json",upsert:true});
          if(acknowledged.error) throw new Error("Evidence acknowledgment deferred");
          await objects.remove([path]);
        } catch {
          // Rotate failed work so one bad item cannot starve older pending files.
          await objects.upload(path, await stored.data.text(), {contentType:"application/json",upsert:true});
          console.warn("[Media memory] retry deferred");
        }
      }
    },
    async originalExists(chatId: string, id: string, actorId: string): Promise<boolean | null> {
      const path=conversationPath(chatId,id);
      const stored=await objects.download(`${path}.json`);
      if(!stored.data) return null;
      const record=JSON.parse(await stored.data.text());
      if(record.actorId!==actorId) return null;
      if(!record.hasSource) return false;
      // HEAD only: never restore provider access, read source bytes, or decode media.
      const result=await objects.exists(`${path}.source`);
      const status=Number((result.error as {status?:unknown} | null)?.status);
      return status===404 ? false : result.error ? null : result.data;
    },
    // Only trusted canonical metadata is used; no URL or client provenance is accepted.
    async timelineSource(chatId: string, id: string, actorId: string): Promise<{ fingerprint: string; source?: Blob }> {
      const path = conversationPath(chatId, id);
      const stored = await objects.download(`${path}.json`);
      if (!stored.data) throw new UploadInputError("Timeline source metadata is unavailable.");
      const record = JSON.parse(await stored.data.text());
      if (record.actorId !== actorId || !record.hasSource || !record.reference?.mimeType?.startsWith("video/"))
        throw new UploadInputError("Verified retained video required.");
      const exists = await objects.exists(`${path}.source`);
      if (exists.error || !exists.data) throw new UploadInputError("Retained original is unavailable.");
      // Hash retained bytes even on cache recall: metadata alone cannot detect
      // replacement at the same private path. No decoding or inference runs here.
      const original = await objects.download(`${path}.source`);
      if (!original.data || !original.data.size || original.data.size > 200 * 1024 * 1024)
        throw new UploadInputError("Timeline original unavailable or too large.");
      const source = original.data;
      const fingerprint = createHash("sha256").update(Buffer.from(await source.arrayBuffer())).digest("hex");
      if (record.sourceFingerprint && fingerprint !== record.sourceFingerprint)
        throw new UploadInputError("Retained source fingerprint changed.");
      return { fingerprint, source };
    },
    async pdfEvidence(currentChat: string, attachment: ConversationAttachment, actorId: string, message: string, owns: (id:string)=>Promise<boolean>, analysisMessage = message): Promise<PdfEvidence> {
      const chatId=attachment.chatId ?? currentChat;
      const live=async()=>await owns(currentChat) && await owns(chatId);
      if (!await live()) throw new UploadInputError("PDF source chat unavailable.");
      const path=conversationPath(chatId,attachment.id);
      const stored=await objects.download(`${path}.json`);
      if (!stored.data) throw new UploadInputError("PDF source metadata unavailable.");
      const record=JSON.parse(await stored.data.text());
      const reference=record.reference as FileReference;
      if(record.actorId!==actorId || reference.mimeType!=="application/pdf" || !reference.pdfInventory || !reference.sourceFingerprint) throw new UploadInputError("Verified PDF inventory unavailable; reattach legacy source.");
      const original=await objects.download(`${path}.source`);
      if(!original.data) throw new UploadInputError("PDF original unavailable; saved findings may still exist in search.");
      if(original.data.size>8*1024*1024) throw new UploadInputError("Retained PDF exceeds the 8MB limit.");
      const fingerprint=createHash("sha256").update(Buffer.from(await original.data.arrayBuffer())).digest("hex");
      if(fingerprint!==reference.sourceFingerprint) throw new UploadInputError("PDF source changed.");
      // Immutable page receipts avoid lost completed pages when follow-ups race.
      const pagePrefix=`chats/${chatId}`;
      const pageNamePrefix=`${attachment.id}.pdf-page-`;
      const listing=await objects.list(pagePrefix,{limit:128,search:pageNamePrefix});
      if(listing.error) throw new Error("PDF page receipt listing unavailable.");
      const receipts=await Promise.all((listing.data ?? []).filter(entry=>entry.name.startsWith(pageNamePrefix) && /^\d{6}\.json$/.test(entry.name.slice(pageNamePrefix.length))).map(async entry=>{
        const saved=await objects.download(`${pagePrefix}/${entry.name}`);
        return saved.data ? JSON.parse(await saved.data.text()) : null;
      }));
      const matching=receipts.filter(envelope=>envelope?.actorId===actorId && envelope?.chatId===chatId && envelope?.attachmentId===attachment.id && envelope?.evidence?.fingerprint===fingerprint);
      let cached:PdfEvidence|undefined=matching.length ? {...matching[0].evidence,pages:matching.flatMap(envelope=>envelope.evidence.pages),rawReports:[...new Set<string>(matching.flatMap(envelope=>envelope.evidence.rawReports))]} : undefined;
      // Page scope belongs to this conversation and retained source, not the
      // first immutable receipt or whichever other chat last inspected it.
      conversationPath(currentChat,attachment.id);
      const scopePath=`${conversationPath(currentChat,attachment.id)}.pdf-scope-${chatId}.json`;
      const storedScope=await objects.download(scopePath);
      let previousPages:number[]|undefined;
      let previousNativeProhibited=true;
      let previousAnalysisTask:string|undefined;
      let previousContextPages:number[]=[];
      if(storedScope.data) {
        try {
          const scope=JSON.parse(await storedScope.data.text());
          if(scope.version==="pdf-scope-v1" && scope.actorId===actorId && scope.sourceChatId===chatId && scope.currentChat===currentChat && scope.attachmentId===attachment.id && scope.fingerprint===fingerprint &&
            Array.isArray(scope.pages) && scope.pages.length>0 && scope.pages.length<=10000 && scope.pages.every((page:unknown)=>Number.isSafeInteger(page) && (page as number)>0 && (page as number)<=reference.pdfInventory!.pageCount) && new Set(scope.pages).size===scope.pages.length)
            { previousPages=scope.pages; previousNativeProhibited=scope.nativeInspectionProhibited!==false; previousAnalysisTask=typeof scope.analysisTask==="string" && scope.analysisTask.length<=4000 ? scope.analysisTask : undefined;
              if(Array.isArray(scope.contextPagesProvided) && scope.contextPagesProvided.length<=scope.pages.length && scope.contextPagesProvided.every((page:unknown)=>scope.pages.includes(page)) && new Set(scope.contextPagesProvided).size===scope.contextPagesProvided.length) previousContextPages=scope.contextPagesProvided; }
        } catch { /* Missing or corrupt scope cannot widen a continuation. */ }
      }
      if(cached) cached={...cached,requestedPages:previousPages,analysisTask:previousAnalysisTask,contextPagesProvided:previousContextPages,nativeInspectionProhibited:previousNativeProhibited};
      else if(previousPages) cached={version:"pdf-visual-v1",capturePolicy:"reusable-page-v1",fingerprint,extractionVersion:"pdf-pages-v1",provider:"google",model:"gemini-2.5-flash",pages:[],rawReports:[],requestedPages:previousPages,analysisTask:previousAnalysisTask,contextPagesProvided:previousContextPages,nativeInspectionProhibited:previousNativeProhibited,state:"partial",notice:""};
      const evidence=await inspectPdf(reference,message,original.data,cached,async pages=>{
        const acquired:number[]=[];
        for(const physicalPage of pages) {
          if(!await live()) throw new UploadInputError("PDF source was deleted.");
          const attemptPath=`${path}.pdf-attempt-${fingerprint}-${String(physicalPage).padStart(6,"0")}-v1.json`;
          const attempt={version:"pdf-attempt-v1",actorId,chatId,attachmentId:attachment.id,fingerprint,physicalPage,model:"gemini-2.5-flash",id:randomUUID(),state:"pending-or-uncertain"};
          // Storage create-only uploads have one winner across processes. Never
          // reset an attempt after ambiguous acknowledgment or model acceptance.
          const claim=await objects.upload(attemptPath,JSON.stringify(attempt),{contentType:"application/json",upsert:false});
          if(!claim.error) { acquired.push(physicalPage); continue; }
          const existing=await objects.download(attemptPath);
          if(!existing.data) throw new Error("PDF attempt unavailable; no inference started.");
          const previous=JSON.parse(await existing.data.text());
          if(previous.actorId!==actorId || previous.chatId!==chatId || previous.attachmentId!==attachment.id || previous.fingerprint!==fingerprint || previous.physicalPage!==physicalPage || previous.version!==attempt.version)
            throw new Error("PDF attempt identity mismatch; no inference started.");
        }
        if(!await live()) throw new UploadInputError("PDF source was deleted.");
        return acquired;
      },async (pages,nativeInspectionProhibited,analysisTask,contextPagesProvided)=>{
        if(!await live()) throw new UploadInputError("PDF source was deleted.");
        const saved=await objects.upload(scopePath,JSON.stringify({version:"pdf-scope-v1",actorId,sourceChatId:chatId,currentChat,attachmentId:attachment.id,fingerprint,pages,nativeInspectionProhibited,analysisTask,contextPagesProvided}),{contentType:"application/json",upsert:true});
        if(saved.error) throw new Error("PDF page scope persistence unavailable; no inference started.");
      },analysisMessage);
      evidence.source={actorId,sourceChatId:chatId,attachmentId:attachment.id};
      if(!await live()) throw new UploadInputError("PDF source was deleted.");
      const known=new Set(cached?.pages.map(page=>page.physicalPage) ?? []);
      for(const page of evidence.pages.filter(page=>!known.has(page.physicalPage))) {
        if(!await live()) throw new UploadInputError("PDF source was deleted.");
        const receipt={actorId,chatId,attachmentId:attachment.id,evidence:{...evidence,pages:[page],rawReports:evidence.rawReports.slice(-1)}};
        const receiptPath=`${path}.pdf-page-${String(page.physicalPage).padStart(6,"0")}.json`;
        const serialized=JSON.stringify(receipt);
        let persisted=false;
        // Retry only deterministic private storage writes, never paid inference.
        // A lost acknowledgment is successful only when the exact receipt exists.
        for(let attempt=0;attempt<3 && !persisted;attempt++) {
          if(!await live()) throw new UploadInputError("PDF source was deleted.");
          try {
            const saved=await objects.upload(receiptPath,serialized,{contentType:"application/json",upsert:false});
            if(!saved.error) { persisted=true; break; }
          } catch { /* Reconcile an ambiguous storage acknowledgment below. */ }
          try {
            const existing=await objects.download(receiptPath);
            if(existing.data && JSON.stringify(JSON.parse(await existing.data.text()))===serialized) persisted=true;
          } catch { /* A bounded retry may recover a transient storage failure. */ }
        }
        if(!persisted) throw new Error("PDF evidence persistence unavailable after three writes; attempt retained, no automatic inference retry.");
        matching.push(receipt);
      }
      if(evidence.pages.length && await live()) {
        // Each immutable page has its own canonical index/version. Concurrent
        // page completions cannot replace another page's searchable findings.
        const markerPrefix=`${attachment.id}.pdf-index-`;
        const indexed=await objects.list(pagePrefix,{limit:128,search:markerPrefix});
        if(indexed.error) evidence.notice+=" Saved page indexing status unavailable; revisit this source without reinspection.";
        else {
          const completed=new Set((indexed.data ?? []).map(item=>item.name));
          const pending=matching.flatMap(envelope=>envelope.evidence.pages.map((page:PdfEvidence["pages"][number])=>{
            const e=envelope.evidence as PdfEvidence;
            // Full native batches stay in private receipts; searchable page
            // identities include only validated fields and opaque report hashes.
            const canonical=JSON.stringify({version:e.version,capturePolicy:e.capturePolicy,extractionVersion:e.extractionVersion,
              source:{actorId,sourceChatId:chatId,attachmentId:attachment.id},fingerprint,
              provider:e.provider,model:e.model,page,rawReportHashes:[...new Set(e.rawReports.map(raw=>createHash("sha256").update(raw).digest("hex")))].sort()});
            const digest=createHash("sha256").update(canonical).digest("hex");
            return {page:page.physicalPage,canonical,version:`pdf-visual-v1:${fingerprint}:page:${page.physicalPage}:${e.model}`,marker:`${markerPrefix}${String(page.physicalPage).padStart(6,"0")}-${digest}.json`};
          })).filter(item=>!completed.has(item.marker)).sort((a,b)=>a.page-b.page);
          for(const item of pending.slice(0,4)) {
            if(!await live()) throw new UploadInputError("PDF source was deleted.");
            try {
              const done=await indexEvidence({...attachment,actorId,chatId},"analysis",item.version,item.canonical,"partial; model-derived physical page observations");
              if(done) {
                const marked=await objects.upload(`${pagePrefix}/${item.marker}`,JSON.stringify({version:item.version,source:{actorId,chatId,attachmentId:attachment.id},complete:true}),{contentType:"application/json",upsert:true});
                if(!marked.error) completed.add(item.marker);
              }
            } catch { /* Immutable page receipts remain available for bounded recovery. */ }
          }
          if(pending.some(item=>!completed.has(item.marker))) evidence.notice+=" Saved evidence indexing unavailable or incomplete; revisit this source to resume without inference.";
        }
      }
      if(!await live()) throw new UploadInputError("PDF source was deleted.");
      return evidence;
    },
    async readVideoTiming(chatId: string, id: string, actorId: string): Promise<VideoTiming | undefined> {
      const stored = await objects.download(`${conversationPath(chatId, id)}.json`);
      if (stored.error || !stored.data) return;
      let record: { actorId?: string; decoderTiming?: unknown; reference?: FileReference };
      try { record = JSON.parse(await stored.data.text()); } catch { return; }
      if (!record || record.actorId !== actorId || typeof record.reference?.mimeType !== "string" ||
          !record.reference.mimeType.startsWith("video/")) return;
      registerVideoTiming(record.reference, record.decoderTiming);
      return getVideoTiming(record.reference);
    },
    async updateImageObservation(chatId:string,attachment:ConversationAttachment,actorId:string,description:Partial<ConversationAttachment>):Promise<ConversationAttachment>{
      const path=conversationPath(chatId,attachment.id);
      const stored=await objects.download(`${path}.json`);
      if(!stored.data)throw new UploadInputError('Saved image evidence metadata is unavailable.');
      const record=JSON.parse(await stored.data.text());
      const image=record.reference?.imageDataUrl;
      if(record.actorId!==actorId || !record.reference?.mimeType?.startsWith('image/') || typeof image!=='string' ||
        createHash('sha256').update(image).digest('hex')!==description.observationSourceHash)
        throw new UploadInputError('Saved image evidence identity does not match its trusted source.');
      const previous=record.evidenceDescriptor??attachment;
      const descriptor:ConversationAttachment={...previous,...description,id:attachment.id,chatId,actorId,fileName:previous.fileName,mimeType:previous.mimeType};
      const history=[...(Array.isArray(record.observationHistory)?record.observationHistory:[]),previous];
      const saved=await objects.upload(`${path}.json`,JSON.stringify({...record,evidenceDescriptor:descriptor,observationHistory:history}),{contentType:'application/json',upsert:true});
      if(saved.error)throw new Error('Unable to retain the new image observation.');
      await writeCatalogEntry(chatId,descriptor);
      return descriptor;
    },
    async restore(chatId: string, attachment: ConversationAttachment, expectedActorId?: string): Promise<FileReference> {
      const path = conversationPath(chatId, attachment.id);
      const stored = await objects.download(`${path}.json`);
      if (stored.error || !stored.data) throw new UploadInputError("The saved attachment is unavailable.");
      const record = JSON.parse(await stored.data.text()) as { reference: FileReference; hasSource: boolean; refreshedAt: number; actorId?: string; decoderTiming?: VideoTiming };
      if (expectedActorId && record.actorId && record.actorId !== expectedActorId) throw new UploadInputError("This file belongs to a different actor.");
      if (record.reference.mimeType === "application/pdf") record.reference.extractionCoverage = "partial";
      if (!record.reference.imageDataUrl && !record.reference.pdfInventory && now() - record.refreshedAt >= RETENTION_MS) {
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
      if (expectedActorId && record.actorId === expectedActorId) registerVideoTiming(record.reference, record.decoderTiming);
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
        reference: FileReference; hasSource: boolean; refreshedAt: number;
        decoderTiming?: VideoTiming; actorId?: string; frameSampleTarget?: number; frameSampleVersion?: number;
      };
      if (record.actorId && record.actorId !== expectedActorId) throw new UploadInputError("Video belongs to another actor.");
      if (!record.reference.mimeType.startsWith("video/")) throw new UploadInputError("Saved attachment is not a video.");
      const existing = record.reference.videoFrames;
      // Older videos may have four cached frames. Resample the retained original
      // once to upgrade them to ten; avoid repeatedly decoding short/corrupt clips.
      if (existing?.length && ((record.frameSampleTarget === MAX_VIDEO_FALLBACK_FRAMES && record.frameSampleVersion === VIDEO_FRAME_SAMPLE_VERSION) || !record.hasSource)) {
        if (expectedActorId && record.actorId === expectedActorId) registerVideoTiming(record.reference, record.decoderTiming);
        return record.reference;
      }
      if (!record.hasSource) throw new UploadInputError("Original video was not retained; cannot extract real frames.");
      const original = await objects.download(`${path}.source`);
      if (original.error || !original.data) {
        if (existing?.length) {
          if (expectedActorId && record.actorId === expectedActorId) registerVideoTiming(record.reference, record.decoderTiming);
          return record.reference;
        }
        throw new UploadInputError("The original saved video is no longer available.");
      }
      let frames: VideoFallbackFrame[];
      try {
        const decoded = await extract(original.data);
        frames = validateVideoFallbackFrames(decoded);
        registerVideoTiming(frames, getVideoTiming(decoded));
      } catch (error) {
        if (!existing?.length) throw error;
        console.warn("[Video Routing] ten-frame upgrade failed; retaining existing frames", {
          attachmentId: attachment.id, previousCount: existing.length,
        });
        if (expectedActorId && record.actorId === expectedActorId) registerVideoTiming(record.reference, record.decoderTiming);
        return record.reference;
      }
      if (!frames.length && !existing?.length) throw new UploadInputError("Server decoded no video frames; Grok visual fallback is unavailable.");
      const upgraded = frames.length >= 7 || !existing?.length;
      record.reference.videoFrames = upgraded ? frames : existing!;
      if (upgraded) record.decoderTiming = getVideoTiming(frames);
      record.frameSampleTarget = MAX_VIDEO_FALLBACK_FRAMES;
      record.frameSampleVersion = upgraded ? VIDEO_FRAME_SAMPLE_VERSION : undefined;
      const saved = await objects.upload(`${path}.json`, JSON.stringify(record), {
        contentType: "application/json", upsert: true
      });
      if (saved.error) throw new Error("Unable to persist recovered video frames.");
      console.info("[Video Routing] saved video frames recovered", {
        attachmentId: attachment.id, frameCount: record.reference.videoFrames.length, source: "saved-conversation"
      });
      if (expectedActorId && record.actorId === expectedActorId) registerVideoTiming(record.reference, record.decoderTiming);
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
      const reference = JSON.parse(await stored.data.text()) as FileReference & { decoderTiming?: VideoTiming; frameSampleTarget?: number; frameSampleVersion?: number };
      const existing = reference.videoFrames;
      if (existing?.length && reference.frameSampleTarget === MAX_VIDEO_FALLBACK_FRAMES &&
          reference.frameSampleVersion === VIDEO_FRAME_SAMPLE_VERSION) {
        registerVideoTiming(reference, reference.decoderTiming);
        return reference;
      }
      const original = await objects.download(sourcePath(ticket));
      if (original.error || !original.data) {
        if (existing?.length) return reference;
        throw new UploadInputError("The uploaded original video is unavailable.");
      }
      let frames: VideoFallbackFrame[];
      try {
        const decoded = await extract(original.data);
        frames = validateVideoFallbackFrames(decoded);
        registerVideoTiming(frames, getVideoTiming(decoded));
      } catch (error) {
        if (!existing?.length) throw error;
        console.warn("[Video Routing] upload ten-frame upgrade failed; retaining existing frames", {
          uploadId: ticket.id, previousCount: existing.length,
        });
        return reference;
      }
      if (!frames.length && !existing?.length) throw new UploadInputError("Server decoded no video frames; Grok visual fallback is unavailable.");
      const upgraded = frames.length >= 7 || !existing?.length;
      reference.videoFrames = upgraded ? frames : existing!;
      if (upgraded) reference.decoderTiming = getVideoTiming(frames);
      reference.frameSampleTarget = MAX_VIDEO_FALLBACK_FRAMES;
      reference.frameSampleVersion = upgraded ? VIDEO_FRAME_SAMPLE_VERSION : undefined;
      const saved = await objects.upload(referencePath(ticket), JSON.stringify(reference), {
        contentType: "application/json", upsert: true
      });
      if (saved.error) throw new Error("Unable to persist recovered video frames.");
      console.info("[Video Routing] uploaded video frames recovered", {
        uploadId: ticket.id, frameCount: reference.videoFrames.length, source: "signed-upload"
      });
      registerVideoTiming(reference, reference.decoderTiming);
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
    async beginProcessing(token: string) {
      const ticket = verify(token, "upload");
      await ensureBucket();
      const completed = await objects.download(referencePath(ticket));
      if (completed.data) {
        return { status: "ready" as const,
          fileReference: compact(JSON.parse(await completed.data.text()) as FileReference, ticket),
          scheduled: false };
      }
      const prior = await readProcessingRecord(ticket);
      if (prior?.status === "processing" && now() - prior.startedAt < processingStaleMs) {
        return { status: "processing" as const, startedAt: prior.startedAt, scheduled: false };
      }
      const record: ProcessingRecord = { status: "processing", startedAt: now() };
      const reserved = await objects.upload(processingPath(ticket), JSON.stringify(record), {
        contentType: "application/json", upsert: prior !== null,
      });
      if (reserved.error) {
        const another = await readProcessingRecord(ticket);
        if (another?.status === "processing" && now() - another.startedAt < processingStaleMs) {
          return { status: "processing" as const, startedAt: another.startedAt, scheduled: false };
        }
        throw new Error("Unable to start video processing.");
      }
      console.info("[Upload API] scheduled detached video processing", {
        uploadId: ticket.id, size: ticket.size, retry: prior !== null,
      });
      return { status: "processing" as const, startedAt: record.startedAt, scheduled: true };
    },
    async processingResult(token: string) {
      const ticket = verify(token, "upload");
      await ensureBucket();
      const completed = await objects.download(referencePath(ticket));
      if (completed.data) {
        return { status: "ready" as const,
          fileReference: compact(JSON.parse(await completed.data.text()) as FileReference, ticket) };
      }
      const record = await readProcessingRecord(ticket);
      if (record?.status === "failed") {
        return { status: "failed" as const, error: record.error || "Video processing failed." };
      }
      if (record?.status === "processing") {
        return { status: "processing" as const, startedAt: record.startedAt };
      }
      return { status: "pending" as const };
    },
    async recordProcessingFailure(token: string, error: unknown) {
      const ticket = verify(token, "upload");
      const message = error instanceof Error ? error.message : String(error);
      const record: ProcessingRecord = {
        status: "failed", startedAt: now(), error: message.slice(0, 350),
      };
      const saved = await objects.upload(processingPath(ticket), JSON.stringify(record), {
        contentType: "application/json", upsert: true,
      });
      if (saved.error) throw new Error("Unable to store video processing failure.");
      console.error("[Upload API] detached video processing failed", {
        uploadId: ticket.id, message: record.error,
      });
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
        const privateReference = JSON.parse(await stored.data.text()) as FileReference & { decoderTiming?: VideoTiming };
        registerVideoTiming(privateReference, privateReference.decoderTiming);
        hydrated.push(privateReference);
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
  return createStoredUploadService(client.storage, key, { indexSaved: indexReference });
}

export const prepareStoredUpload = (input: unknown) => getUploadService().prepare(input);
export const inspectStoredUploadTicket = (token: string) => getUploadService().inspectUpload(token);
export const recoverUnlinkedVideoReference = (uploadId: string) => getUploadService().recoverUnlinkedVideo(uploadId);
export const completeStoredUpload = async (token: string, videoFrames?: unknown) => {
  // First commit the complete original and reference. The browser may vanish at
  // any moment afterward; the durable handoff ledger makes the chat resumable.
  const reference = await getUploadService().complete(token, videoFrames);
  if (reference.attachmentKind === "video") {
    // complete() verified the signed upload ticket before returning.
    const signed = ticketSchema.parse(JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()));
    await recordCompletedHandoffUpload(signed.id, reference);
  }
  return reference;
};
export const beginStoredUploadProcessing = (token: string) => getUploadService().beginProcessing(token);
export const getStoredUploadProcessingResult = (token: string) => getUploadService().processingResult(token);
export const processStoredUploadInBackground = async (token: string): Promise<void> => {
  try {
    console.info("[Upload API] background video processing started");
    await completeStoredUpload(token);
    console.info("[Upload API] background video processing finished");
  } catch (error) {
    console.error("[Upload API] background video processing exception", {
      message: error instanceof Error ? error.message : String(error),
    });
    await getUploadService().recordProcessingFailure(token, error).catch(recordError => {
      console.error("[Upload API] unable to persist processing failure", {
        message: recordError instanceof Error ? recordError.message : String(recordError),
      });
    });
  }
};
export const uploadStoredChunk = (token: string, index: number, bytes: Uint8Array, subIndex?: number) => getUploadService().uploadChunk(token, index, bytes, subIndex);
export const getStoredUploadChunkStatus = (token: string) => getUploadService().chunkStatus(token);
export const signStoredUploadChunks = (token: string, entries: Array<{ index: number; subIndex?: number }>) => getUploadService().signDirectChunks(token, entries);
export const hydrateStoredAttachments = (references: FileReference[]) =>
  references.some(reference => reference.storageToken) ? getUploadService().hydrate(references) : Promise.resolve(references);

export const persistConversationAttachment = (chatId: string, reference: FileReference, token?: string, options?: { source?: Blob; description?: Partial<ConversationAttachment>; actorId?: string }) => getUploadService().persist(chatId, reference, token, options);
export const restoreConversationAttachment = (chatId: string, attachment: ConversationAttachment, actorId?: string) => getUploadService().restore(chatId, attachment, actorId);
export const updateSavedImageObservation = (chatId:string,attachment:ConversationAttachment,actorId:string,description:Partial<ConversationAttachment>) => getUploadService().updateImageObservation(chatId,attachment,actorId,description);
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

function honestPdfSummary(file: ConversationAttachment): ConversationAttachment {
  return file.mimeType === "application/pdf" ? { ...file,
    summaryCoverage: file.summaryCoverage === "full" ? "sampled" : file.summaryCoverage,
    observedSummary: `[PDF discovery summary; page/visual completeness unverified.] ${file.observedSummary ?? ""}`,
  } : file;
}

export async function loadActorAttachmentCatalog(actorId: string, legacyLoader: () => Promise<ConversationAttachment[]>): Promise<ConversationAttachment[]> {
  const service = getUploadService();
  const catalog = await service.catalog(actorId, "actor");
  if (catalog.initialized) return catalog.attachments.filter(file => file.actorId === actorId).map(honestPdfSummary);
  const combined = [...new Map([...(await legacyLoader()), ...catalog.attachments].map(file => [file.id, { ...file, actorId }])).values()];
  await service.initializeCatalog(actorId, combined, "actor");
  return combined.map(honestPdfSummary);
}

export const readSavedVideoTiming = (chatId: string, id: string, actorId: string) => getUploadService().readVideoTiming(chatId, id, actorId);

export const retrySavedEvidence = (actorId: string, owns: (chatId: string) => Promise<boolean>, catalog: ConversationAttachment[] = []) => getUploadService().retryEvidence(actorId, owns, catalog);

export const savedOriginalExists = (chatId: string, id: string, actorId: string) => getUploadService().originalExists(chatId,id,actorId);

export const readTimelineSource = (chatId: string, id: string, actorId: string) => getUploadService().timelineSource(chatId, id, actorId);

export const inspectSavedPdf = (currentChat:string,attachment:ConversationAttachment,actorId:string,message:string,owns:(id:string)=>Promise<boolean>,analysisMessage=message) => getUploadService().pdfEvidence(currentChat,attachment,actorId,message,owns,analysisMessage);

export const ingestPdfUploads = (files:File[]) => getUploadService().ingestPdfUploads(files);
