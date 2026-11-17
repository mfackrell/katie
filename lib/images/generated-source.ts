import { createHash } from 'node:crypto';

export const GENERATED_IMAGE_VERSION = 'generated-image-source-v1' as const;
export type ImageParent = { attachmentId: string; sourceChatId: string; sourceHash?: string };
export type GeneratedImageProvenance = {
  version: typeof GENERATED_IMAGE_VERSION;
  origin: 'assistant-generated';
  /** Legacy assistant assets may have no surviving generation receipt. */
  registration: 'generation-result' | 'legacy-assistant-asset';
  actorId: string;
  chatId: string;
  messageId: string;
  requestId: string | null;
  imageIndex: number;
  createdAt: string;
  provider: string | null;
  model: string;
  /** SHA-256 of retained ORIGINAL bytes, not of a prompt or resized rendering. */
  sourceHash: string;
  parents: ImageParent[];
};
export type GeneratedImageBinding = Omit<GeneratedImageProvenance, 'version'|'origin'|'sourceHash'>;
export type ImageAsset = {
  type: string; url: string;
  attachmentId?: string;
  sourceChatId?: string;
  sourceMessageId?: string;
  sourceHash?: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateGeneratedBinding(value: GeneratedImageBinding): void {
  if (![value.actorId,value.chatId,value.messageId].every(v => uuid.test(v)) ||
    !Number.isInteger(value.imageIndex) || value.imageIndex < 0 || value.imageIndex > 4 ||
    !Number.isFinite(Date.parse(value.createdAt)) || !value.model?.trim() ||
    !['generation-result','legacy-assistant-asset'].includes(value.registration) ||
    (value.registration === 'generation-result' && (!value.requestId || !value.provider)) ||
    value.parents.length > 5 || value.parents.some(p => !uuid.test(p.attachmentId) || !uuid.test(p.sourceChatId)))
    throw new Error('Invalid generated-image source binding.');
}
/** A retry of one assistant output slot cannot create a second attachment. */
export function generatedImageId(binding: Pick<GeneratedImageBinding,'actorId'|'chatId'|'messageId'|'imageIndex'>): string {
  const hex = createHash('sha256').update(JSON.stringify([
    GENERATED_IMAGE_VERSION,binding.actorId,binding.chatId,binding.messageId,binding.imageIndex,
  ])).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export const originalImageHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
