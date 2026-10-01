import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ConversationAttachment } from "@/lib/chat/attachment-continuity";
import type { FileReference } from "@/lib/providers/types";
import { buildFileReferences, validateUploadFiles } from "./build-file-references";

const BUCKET = "katie-attachments";
const RETENTION_MS = 24 * 60 * 60 * 1000;
export const uploadMetadataSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.string().max(128),
  size: z.number().int().positive().max(200 * 1024 * 1024),
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
  const referencePath = (ticket: Ticket) => `references/${ticket.id}.json`;
  const compact = (reference: FileReference, ticket: Ticket): FileReference => {
    const metadata = { ...reference };
    delete metadata.extractedText;
    delete metadata.extractedChunks;
    delete metadata.imageDataUrl;
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
    for (const prefix of ["incoming", "references"]) {
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
        record.reference = renewed;
        record.refreshedAt = now();
        const updated = await objects.upload(`${path}.json`, JSON.stringify(record), { contentType: "application/json", upsert: true });
        if (updated.error) throw new Error("Unable to save renewed video access.");
      }
      return record.reference;
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
      return { uploadUrl: signed.data.signedUrl, uploadToken: sign(ticket) };
    },
    async complete(token: string): Promise<FileReference> {
      const ticket = verify(token, "upload");
      const cached = await objects.download(referencePath(ticket));
      if (cached.data) return compact(JSON.parse(await cached.data.text()) as FileReference, ticket);
      const source = await objects.download(sourcePath(ticket));
      if (source.error || !source.data) throw new UploadInputError("The file upload did not finish. Please attach the file again.");
      if (source.data.size !== ticket.size) {
        await objects.remove([sourcePath(ticket)]);
        throw new UploadInputError("The uploaded file size does not match the original. Please attach the file again.");
      }
      const file = new File([source.data], ticket.name, { type: ticket.type });
      const [reference] = await buildReferences([file]);
      if (!reference) throw new Error("Attachment processing returned no file reference.");
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
export const completeStoredUpload = (token: string) => getUploadService().complete(token);
export const hydrateStoredAttachments = (references: FileReference[]) =>
  references.some(reference => reference.storageToken) ? getUploadService().hydrate(references) : Promise.resolve(references);

export const persistConversationAttachment = (chatId: string, reference: FileReference, token?: string, options?: { source?: Blob; description?: Partial<ConversationAttachment>; actorId?: string }) => getUploadService().persist(chatId, reference, token, options);
export const restoreConversationAttachment = (chatId: string, attachment: ConversationAttachment, actorId?: string) => getUploadService().restore(chatId, attachment, actorId);
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
