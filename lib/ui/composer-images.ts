import type { FileReference } from '@/lib/providers/types';

/** A visible selection and its source travel together, including across drafts. */
export type ComposerImage = { preview: string; file?: File; reference?: FileReference };
const supported = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const usableFile = (file?: File): boolean => !!file && typeof file.name === 'string' && !!file.name && supported.has(file.type) && file.size > 0 && typeof file.arrayBuffer === 'function';
export const isImageReference = (reference: FileReference) => reference.attachmentKind === 'image' || reference.mimeType.startsWith('image/');

export function imageFileFromPreview(preview: string, name = 'restored-image'): File {
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(preview);
  if (!match || match[2].length % 4 !== 0) throw Error('An image preview has no recoverable source. Remove it and attach the image again.');
  if(match[2].length > Math.ceil(20 * 1024 * 1024 / 3) * 4)throw Error('The selected image exceeds the 20 MiB upload limit. Attach a smaller image.');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0)); }
  catch { throw Error('An image preview has no recoverable source. Remove it and attach the image again.'); }
  if (!bytes.length) throw Error('The selected image is empty. Remove it and attach the image again.');
  if(bytes.length > 20 * 1024 * 1024)throw Error('The selected image exceeds the 20 MiB upload limit. Attach a smaller image.');
  const starts = (...header: number[]) => header.every((byte,index)=>bytes[index]===byte);
  const signature = match[1] === 'image/png' ? starts(137,80,78,71,13,10,26,10)
    : match[1] === 'image/jpeg' ? starts(255,216,255)
    : match[1] === 'image/gif' ? starts(71,73,70,56)
    : starts(82,73,70,70) && bytes[8]===87 && bytes[9]===69 && bytes[10]===66 && bytes[11]===80;
  if(!signature)throw Error('An image preview has no recoverable source. Remove it and attach the image again.');
  const extension = match[1].split('/')[1].replace('jpeg', 'jpg');
  return new File([bytes.buffer as ArrayBuffer], `${name}.${extension}`, {type: match[1]});
}

export function composerImage(preview: string, file?: File): ComposerImage {
  return {preview, file: usableFile(file) ? file : imageFileFromPreview(preview, file?.name)};
}

/** Legacy receipts never establish a fresh visible selection. */
export function migrateComposerImages(images: Array<string | ComposerImage>): ComposerImage[] {
  // Parallel legacy arrays cannot prove which File belongs to a preview, even
  // when their lengths match. Reconstruct each explicit visible source instead.
  return images.map(image => typeof image === 'string' ? {preview: image} : image);
}

export function prepareComposerImages(images: ComposerImage[]): {files: File[]; references: FileReference[]} {
  const files: File[] = [], references: FileReference[] = [];
  for (const [index, image] of images.entries()) {
    if (image.reference && typeof image.reference.storageToken === "string" && image.reference.storageToken.trim()) {
      if (!isImageReference(image.reference) || !image.reference.fileId || !image.reference.fileName) throw Error('A selected image has an invalid saved source. Remove it and attach it again.');
      references.push(image.reference);
    } else {
      const file = usableFile(image.file) ? image.file! : imageFileFromPreview(image.preview, `restored-image-${index + 1}`);
      files.push(file);
    }
  }
  return {files, references};
}

/** The upload service returns one receipt per input in the same order. Never
 * discard previews until every visible image has its matching receipt. */
export function assertImageUploadReferences(files: File[], references: FileReference[]): void {
  if (files.length !== references.length) throw Error('Image upload did not return every selected image. Your images remain selected; try again.');
  const ids = new Set<string>();
  for (const [index, file] of files.entries()) {
    const reference = references[index];
    if (!reference || !isImageReference(reference) || reference.fileName !== file.name.trim() || reference.mimeType !== file.type || !reference.fileId || typeof reference.storageToken !== "string" || !reference.storageToken.trim() || ids.has(reference.fileId)) {
      throw Error('Image upload returned a mismatched image source. Your images remain selected; attach them again.');
    }
    ids.add(reference.fileId);
  }
}
