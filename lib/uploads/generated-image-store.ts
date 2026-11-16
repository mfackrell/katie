import { createHash } from 'node:crypto';
import type { createClient } from '@supabase/supabase-js';
import type { FileReference } from '@/lib/providers/types';
import type { ConversationAttachment } from '@/lib/chat/attachment-continuity';
import { GENERATED_IMAGE_VERSION, generatedImageId, originalImageHash, validateGeneratedBinding,
  type GeneratedImageBinding } from '@/lib/images/generated-source';

type Objects = ReturnType<ReturnType<typeof createClient>['storage']['from']>;
type RecordData = {
  actorId: string; reference: FileReference; hasSource: boolean; sourceFingerprint: string;
  renderingHash: string; refreshedAt: number; evidenceDescriptor: ConversationAttachment;
};
export class GeneratedImageUnavailable extends Error {
  constructor(message = 'The saved generated-image original is unavailable on this turn.') { super(message); }
}
export class GeneratedImageInspectionPending extends Error {
  constructor() { super('Inspection of this exact image is already owned by another saved request. Resume that request; no duplicate inspection was started.'); }
}
export function createGeneratedImageStore(deps: {
  objects: Objects;
  ensureBucket: () => Promise<void>;
  path: (chatId:string,id:string) => string;
  writeCatalogEntry: (chatId:string,descriptor:ConversationAttachment) => Promise<void>;
}) {
  const {objects,path} = deps;
  async function read(actorId:string,chatId:string,id:string): Promise<RecordData> {
    const saved = await objects.download(`${path(chatId,id)}.json`);
    if (saved.error || !saved.data) throw new GeneratedImageUnavailable();
    const record = JSON.parse(await saved.data.text()) as RecordData;
    const d = record.evidenceDescriptor, g = d?.generatedSource;
    if (record.actorId !== actorId || !record.hasSource || !g ||
      g.version !== GENERATED_IMAGE_VERSION || g.origin !== 'assistant-generated' ||
      g.actorId !== actorId || g.chatId !== chatId || d.id !== id || d.chatId !== chatId ||
      generatedImageId(g) !== id || g.sourceHash !== record.sourceFingerprint ||
      !/^[0-9a-f]{64}$/.test(g.sourceHash) || !record.reference?.mimeType?.startsWith('image/') ||
      record.reference.fileId !== id || typeof record.reference.imageDataUrl !== 'string' ||
      createHash('sha256').update(record.reference.imageDataUrl).digest('hex') !== record.renderingHash)
      throw new GeneratedImageUnavailable('Generated-image source ownership or identity could not be verified.');
    return record;
  }
  async function original(record:RecordData):Promise<Blob> {
    const d = record.evidenceDescriptor;
    const source = await objects.download(`${path(d.chatId!,d.id)}.source`);
    if (source.error || !source.data || originalImageHash(new Uint8Array(await source.data.arrayBuffer())) !== record.sourceFingerprint)
      throw new GeneratedImageUnavailable();
    return source.data;
  }
  async function putImmutable(key:string,body:Blob|string,mime:string):Promise<void> {
    const result = await objects.upload(key,body,{contentType:mime,upsert:false});
    if (!result.error) return;
    // A conflict is only idempotent after reading the real prior object. Other
    // storage failures are never interpreted as a completed write.
    const prior = await objects.download(key);
    if (prior.error || !prior.data) throw new GeneratedImageUnavailable('Unable to retain generated-image source.');
    const actual = new Uint8Array(await prior.data.arrayBuffer());
    const expected = typeof body === 'string' ? Buffer.from(body) : new Uint8Array(await body.arrayBuffer());
    if (originalImageHash(actual) !== originalImageHash(expected))
      throw new GeneratedImageUnavailable('Generated-image retry conflicts with the retained source.');
  }
  return {
    async persistGenerated(reference:FileReference,source:Blob,binding:GeneratedImageBinding):Promise<ConversationAttachment> {
      validateGeneratedBinding(binding);
      await deps.ensureBucket();
      if (!source.size || source.size > 20*1024*1024 || !reference.mimeType.startsWith('image/') || !reference.imageDataUrl)
        throw new GeneratedImageUnavailable('Generated-image bytes or validated rendering are unavailable.');
      const id = generatedImageId(binding), prefix = path(binding.chatId,id);
      const sourceHash = originalImageHash(new Uint8Array(await source.arrayBuffer()));
      await putImmutable(`${prefix}.source`,source,reference.mimeType);
      const generatedSource = {...binding,version:GENERATED_IMAGE_VERSION,origin:'assistant-generated' as const,sourceHash};
      const descriptor:ConversationAttachment = {id,fileName:reference.fileName,mimeType:reference.mimeType,
        actorId:binding.actorId,chatId:binding.chatId,createdAt:binding.createdAt,hasOriginal:true,
        conversationUsage:'generated',generatedSource,summaryCoverage:'metadata'};
      const record:RecordData = {actorId:binding.actorId,reference:{...reference,fileId:id},hasSource:true,
        sourceFingerprint:sourceHash,renderingHash:createHash('sha256').update(reference.imageDataUrl).digest('hex'),refreshedAt:Date.parse(binding.createdAt),evidenceDescriptor:descriptor};
      // Never overwrite a completed observation when generation persistence is retried.
      const written = await objects.upload(`${prefix}.json`,JSON.stringify(record),{contentType:'application/json',upsert:false});
      if (written.error) {
        const prior = await read(binding.actorId,binding.chatId,id);
        const p = prior.evidenceDescriptor.generatedSource!;
        if (p.sourceHash !== sourceHash || p.messageId !== binding.messageId || p.imageIndex !== binding.imageIndex ||
          p.requestId !== binding.requestId || p.provider !== binding.provider || p.model !== binding.model ||
          JSON.stringify(p.parents) !== JSON.stringify(binding.parents))
          throw new GeneratedImageUnavailable('Generated-image output slot has conflicting provenance.');
        await original(prior);
        await deps.writeCatalogEntry(binding.chatId,prior.evidenceDescriptor);
        return prior.evidenceDescriptor;
      }
      await deps.writeCatalogEntry(binding.chatId,descriptor);
      return descriptor;
    },
    async readGenerated(actorId:string,chatId:string,id:string) {
      const record = await read(actorId,chatId,id);
      const bytes = await original(record);
      return {descriptor:record.evidenceDescriptor,reference:record.reference,source:bytes};
    },
    /** A permanent source/question claim prevents another request from paying
     * again after a crash or uncertain provider outcome. Only the same durable
     * request can resume; the normal provider ledger controls retransmission. */
    async withGeneratedObservation<T>(input:{actorId:string;chatId:string;id:string;requestId:string;key:string},
      inspect:()=>Promise<T>):Promise<T> {
      const record = await read(input.actorId,input.chatId,input.id);
      await original(record);
      const digest = createHash('sha256').update(JSON.stringify([record.sourceFingerprint,record.renderingHash,input.key])).digest('hex');
      // Flat names stay covered by existing conversation deletion/cleanup.
      const prefix = `${path(input.chatId,input.id)}.observation-${digest}`;
      const resultPath = `${prefix}.result.json`;
      const loadResult = async ():Promise<{value:T}|null> => {
        const stored = await objects.download(resultPath);
        if (!stored.data) return null;
        const result = JSON.parse(await stored.data.text());
        if (result.sourceHash !== record.sourceFingerprint || result.key !== input.key)
          throw new GeneratedImageUnavailable('Saved generated-image observation identity is inconsistent.');
        return {value:result.value as T};
      };
      const existing = await loadResult();
      if (existing) return existing.value;
      const claim = {requestId:input.requestId,sourceHash:record.sourceFingerprint,key:input.key};
      const acquired = await objects.upload(`${prefix}.claim.json`,JSON.stringify(claim),{contentType:'application/json',upsert:false});
      if (acquired.error) {
        const completed = await loadResult();
        if (completed) return completed.value;
        const old = await objects.download(`${prefix}.claim.json`);
        if (!old.data) throw new GeneratedImageUnavailable('Image observation claim could not be saved.');
        const saved = JSON.parse(await old.data.text());
        if (saved.sourceHash !== claim.sourceHash || saved.key !== claim.key || saved.requestId !== claim.requestId)
          throw new GeneratedImageInspectionPending();
      }
      const value = await inspect();
      // Recheck deletion/ownership before publishing completion.
      await original(await read(input.actorId,input.chatId,input.id));
      await putImmutable(resultPath,JSON.stringify({sourceHash:record.sourceFingerprint,key:input.key,value}),'application/json');
      return value;
    },
  };
}
