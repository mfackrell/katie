import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
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
  return {
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
      const removed = await objects.remove([sourcePath(ticket)]);
      if (removed.error) console.warn("[Upload API] temporary source cleanup failed", { fileId: reference.fileId });
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
