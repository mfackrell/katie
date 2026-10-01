import sharp from "sharp";
import type { FileReference } from "@/lib/providers/types";

export const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export async function buildImageReference(file: File): Promise<FileReference> {
  if (!IMAGE_MIME_TYPES.has(file.type) || !file.size || file.size > MAX_IMAGE_BYTES) throw new Error("Use a JPEG, PNG, WebP or GIF image up to 20 MB.");
  const source = Buffer.from(await file.arrayBuffer());
  // Retain the original separately. Only the provider-facing rendering is bounded.
  const metadata = await sharp(source, { limitInputPixels: 100_000_000 }).metadata();
  let data: Buffer = source;
  let mime = file.type;
  if (source.length > 4_000_000 || file.type === "image/gif" || (metadata.width ?? 0) > 8000 || (metadata.height ?? 0) > 8000) {
    data = await sharp(source).rotate().resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    if (data.length > 4_000_000) data = await sharp(source).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
    mime = "image/jpeg";
  }
  return {
    fileId: crypto.randomUUID(), fileName: file.name, mimeType: file.type, attachmentKind: "image",
    preview: `Image ${file.name}, ${metadata.width} × ${metadata.height} pixels. Original retained; provider image may be resized or use the first GIF frame.`,
    imageDataUrl: `data:${mime};base64,${data.toString("base64")}`, extractionCoverage: "preview-only",
  };
}

export function imageFileFromDataUrl(dataUrl: string, name = `image-${crypto.randomUUID()}`): File {
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match || dataUrl.length > MAX_IMAGE_BYTES * 1.4) throw new Error("Invalid inline image. Attach a JPEG, PNG, WebP or GIF file instead.");
  return new File([Buffer.from(match[2], "base64")], `${name}.${match[1].split("/")[1]}`, { type: match[1] });
}
