import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Inspection } from './model';

export const DOCUMENT_BUCKET = 'katie-attachments';
export const scopeSchema = z.object({ ownerId: z.string().uuid(), actorId: z.string().uuid(), chatId: z.string().uuid(), requestId: z.string().min(1).max(128) }).strict();
export type DocumentScope = z.infer<typeof scopeSchema>;
export const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fileSchema = z.object({ filename: z.string().regex(/^[a-zA-Z0-9_-]+\.(docx|pdf)$/), mime: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(8_000_000) }).strict();
export const receiptSchema = z.object({ version: z.literal(1), id: z.string().regex(/^[a-f0-9]{64}$/), scope: scopeSchema,
  files: z.object({ docx: fileSchema, pdf: fileSchema }).strict(), pages: z.number().int().min(1).max(8),
  inspectedPageHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(8),
  correctionCount: z.number().int().min(0).max(3), createdAt: z.string(),
}).strict();
export type DocumentReceipt = z.infer<typeof receiptSchema>;
type Storage = ReturnType<typeof createClient>['storage'];
const MIME = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf' };

export function createDocumentStore(storage: Storage) {
  const objects = storage.from(DOCUMENT_BUCKET);
  const path = (chatId: string, id: string, ext: string) => `chats/${z.string().uuid().parse(chatId)}/document-${z.string().regex(/^[a-f0-9]{64}$/).parse(id)}.${ext}`;
  async function privateBucket() {
    let bucket = await storage.getBucket(DOCUMENT_BUCKET);
    if (!bucket.data) {
      await storage.createBucket(DOCUMENT_BUCKET, { public: false });
      bucket = await storage.getBucket(DOCUMENT_BUCKET);
    }
    if (bucket.error || !bucket.data || bucket.data.public) throw new Error('Private document storage is unavailable.');
  }
  async function writeVerified(key: string, bytes: Buffer, mime: string) {
    const saved = await objects.upload(key, bytes, { contentType: mime, upsert: false });
    // A previously committed identical object is safe to reuse; never overwrite another artifact.
    const read = await objects.download(key);
    if (read.error || !read.data || hash(Buffer.from(await read.data.arrayBuffer())) !== hash(bytes))
      throw new Error(saved.error ? 'Document upload failed; no download was delivered.' : 'Stored document failed read-back validation.');
  }
  return {
    async save(scopeInput: DocumentScope, files: { docx: Buffer; pdf: Buffer }, inspection: Inspection, correctionCount: number): Promise<DocumentReceipt> {
      const scope = scopeSchema.parse(scopeInput);
      if (inspection.findings.length || inspection.visual !== 'passed' || inspection.pageHashes.length !== inspection.pageCount) throw new Error('Unvalidated documents cannot be delivered.');
      if (files.docx.subarray(0, 2).toString() !== 'PK' || files.pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid artifact formats.');
      await privateBucket();
      const id = hash(Buffer.from(JSON.stringify([scope, hash(files.docx), hash(files.pdf)])));
      const prior = await objects.download(path(scope.chatId, id, 'json'));
      if (prior.data) {
        const existing = receiptSchema.parse(JSON.parse(await prior.data.text()));
        if (existing.id !== id || JSON.stringify(existing.scope) !== JSON.stringify(scope)) throw new Error('Document receipt scope mismatch.');
        for (const ext of ['docx', 'pdf'] as const) {
          if (existing.files[ext].sha256 !== hash(files[ext])) throw new Error('Document receipt integrity mismatch.');
          await writeVerified(path(scope.chatId, id, ext), files[ext], MIME[ext]);
        }
        return existing;
      }
      const receipt = receiptSchema.parse({ version: 1, id, scope,
        files: Object.fromEntries((['docx', 'pdf'] as const).map(ext => [ext, { filename: `document.${ext}`, mime: MIME[ext], sha256: hash(files[ext]), size: files[ext].length }])),
        pages: inspection.pageCount, inspectedPageHashes: inspection.pageHashes, correctionCount, createdAt: new Date().toISOString(),
      });
      for (const ext of ['docx', 'pdf'] as const) await writeVerified(path(scope.chatId, id, ext), files[ext], MIME[ext]);
      await writeVerified(path(scope.chatId, id, 'json'), Buffer.from(JSON.stringify(receipt)), 'application/json');
      return receipt;
    },
    async read(scope: Pick<DocumentScope, 'ownerId' | 'actorId' | 'chatId'>, id: string, format: 'docx' | 'pdf') {
      await privateBucket();
      const metadata = await objects.download(path(scope.chatId, id, 'json'));
      if (metadata.error || !metadata.data || metadata.data.size > 16000) throw new Error('Document not found.');
      const receipt = receiptSchema.parse(JSON.parse(await metadata.data.text()));
      if (receipt.id !== id || receipt.scope.ownerId !== scope.ownerId || receipt.scope.actorId !== scope.actorId || receipt.scope.chatId !== scope.chatId) throw new Error('Document access denied.');
      const file = receipt.files[format];
      if (file.mime !== MIME[format]) throw new Error('Invalid artifact type.');
      const stored = await objects.download(path(scope.chatId, id, format));
      if (stored.error || !stored.data || stored.data.size !== file.size) throw new Error('Stored document is unavailable.');
      const bytes = Buffer.from(await stored.data.arrayBuffer());
      if (hash(bytes) !== file.sha256) throw new Error('Stored document integrity check failed.');
      return { bytes, file, receipt };
    },
  };
}
export function documentStore() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Document storage configuration unavailable.');
  return createDocumentStore(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).storage);
}
export function documentLinks(receipt: DocumentReceipt): string {
  const base = `/api/documents/download?actorId=${receipt.scope.actorId}&chatId=${receipt.scope.chatId}&id=${receipt.id}`;
  return `Created and inspected ${receipt.pages} page${receipt.pages === 1 ? '' : 's'}.\n\n[Download Word document](${base}&format=docx) · [Download PDF](${base}&format=pdf)`;
}
