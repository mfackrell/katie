import { z } from 'zod';
import type { FileReference } from '@/lib/providers/types';

export const attachmentManifestSchema = z.object({
  imageCount: z.number().int().min(0).max(5),
  videoCount: z.number().int().min(0).max(5),
  fileCount: z.number().int().min(0).max(5),
}).strict().refine(value=>value.imageCount+value.videoCount+value.fileCount<=5,'Attach up to five files per message.');
export type AttachmentManifest = z.infer<typeof attachmentManifestSchema>;
export class AttachmentIntegrityError extends Error {
  readonly code = 'attachment_integrity';
  readonly status = 400;
  constructor(message:string){super(message);this.name='AttachmentIntegrityError';}
}

/** Counts describe current-turn sources only. They never establish ownership,
 * authorize restoration of historical media, or replace token verification. */
export function countCurrentAttachments(references:Pick<FileReference,'mimeType'|'attachmentKind'>[],images:readonly string[]=[]):AttachmentManifest {
  const result:AttachmentManifest={imageCount:images.length,videoCount:0,fileCount:0};
  for(const reference of references){
    if(reference.mimeType.startsWith('image/')||reference.attachmentKind==='image')result.imageCount++;
    else if(reference.mimeType.startsWith('video/')||reference.attachmentKind==='video')result.videoCount++;
    else result.fileCount++;
  }
  return result;
}
export function validateAttachmentManifest(manifest:unknown,references:Pick<FileReference,'mimeType'|'attachmentKind'>[],images:readonly string[]=[]):AttachmentManifest {
  const received=countCurrentAttachments(references,images);
  // Older saved workflows and managed integrations predate the manifest. They
  // retain existing authorization and hydration checks; the new composer sends it.
  if(manifest===undefined)return received;
  const parsed=attachmentManifestSchema.safeParse(manifest);
  if(!parsed.success)throw new AttachmentIntegrityError('Invalid current-turn attachment manifest. Select your attachments again before sending.');
  for(const key of ['imageCount','videoCount','fileCount'] as const){
    if(parsed.data[key]!==received[key])throw new AttachmentIntegrityError(`Attachment integrity failure: expected ${parsed.data[key]} ${key.replace('Count','')} attachments, received ${received[key]}. The request was stopped before processing attachments or history.`);
  }
  return received;
}

/** Compare the manifest again against server-restored sources. A label saying
 * image is not proof that private pixels survived upload and hydration. */
export function validateHydratedAttachmentManifest(manifest:unknown,references:FileReference[]):AttachmentManifest {
  const counts=validateAttachmentManifest(manifest,references);
  if(manifest!==undefined){
    for(const reference of references){
      if((reference.mimeType.startsWith('image/')||reference.attachmentKind==='image')&&
        (typeof reference.imageDataUrl!=='string'||!/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(reference.imageDataUrl))){
        throw new AttachmentIntegrityError('Attachment integrity failure: a current image has no restored private image source. Attach it again; historical attachments will not replace it.');
      }
    }
  }
  return counts;
}
