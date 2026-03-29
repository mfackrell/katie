import { FileReference } from "@/lib/providers/types";

const MAX_FILES = 5;
const MAX_TEXT_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_FILE_SIZE_BYTES = 200 * 1024 * 1024;
const PREVIEW_MAX_CHARS = 2000;
const CSV_PREVIEW_MAX_ROWS = 50;

const ALLOWED_TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv"
]);

const ALLOWED_TEXT_EXTENSIONS = new Set([".txt", ".md", ".json", ".csv"]);
const ALLOWED_VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v"
]);
const ALLOWED_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v"]);

function getExtension(name: string): string {
  const lastDotIndex = name.lastIndexOf(".");
  if (lastDotIndex < 0) {
    return "";
  }

  return name.slice(lastDotIndex).toLowerCase();
}

function isAllowedTextFileType(file: File): boolean {
  if (file.type.startsWith("video/")) {
    return false;
  }

  if (ALLOWED_TEXT_MIME_TYPES.has(file.type)) {
    return true;
  }

  return ALLOWED_TEXT_EXTENSIONS.has(getExtension(file.name));
}

function isAllowedVideoFileType(file: File): boolean {
  if (ALLOWED_VIDEO_MIME_TYPES.has(file.type)) {
    return ALLOWED_VIDEO_EXTENSIONS.has(getExtension(file.name));
  }

  return false;
}

function getAttachmentKind(file: File): FileReference["attachmentKind"] {
  if (isAllowedVideoFileType(file)) {
    return "video";
  }

  if (isAllowedTextFileType(file)) {
    return "text";
  }

  return "file";
}

function buildCsvPreview(text: string): string {
  const rows = text.split(/\r?\n/).slice(0, CSV_PREVIEW_MAX_ROWS);
  const preview = rows.join("\n");
  return preview.length > PREVIEW_MAX_CHARS ? `${preview.slice(0, PREVIEW_MAX_CHARS)}…` : preview;
}

function buildTextPreview(text: string): string {
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
}

async function uploadToOpenAi(file: File): Promise<string | undefined> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey, fetch: globalThis.fetch.bind(globalThis) });
  const uploaded = await client.files.create({
    file,
    purpose: "user_data"
  });
  return uploaded.id;
}

async function uploadToGoogle(file: File): Promise<string | undefined> {
  const apiKey = process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }

  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey });
  const upload = await client.files.upload({
    file,
    config: {
      mimeType: file.type || undefined
    }
  });
  return upload.uri ?? undefined;
}

export async function buildFileReferences(files: File[]): Promise<FileReference[]> {
  if (files.length > MAX_FILES) {
    throw new Error(`Too many files. Maximum allowed is ${MAX_FILES}.`);
  }

  return Promise.all(
    files.map(async (file) => {
      if (!isAllowedTextFileType(file) && !isAllowedVideoFileType(file)) {
        throw new Error(
          `Unsupported file type for \"${file.name}\". Allowed types: txt, md, json, csv, mp4, mov, webm, m4v.`,
        );
      }

      if (file.size === 0) {
        throw new Error(`File \"${file.name}\" is empty.`);
      }

      const attachmentKind = getAttachmentKind(file);
      const sizeLimit = attachmentKind === "video" ? MAX_VIDEO_FILE_SIZE_BYTES : MAX_TEXT_FILE_SIZE_BYTES;

      if (file.size > sizeLimit) {
        const maxSizeMb = attachmentKind === "video" ? 200 : 10;
        throw new Error(`File \"${file.name}\" is too large. Maximum ${attachmentKind} file size is ${maxSizeMb}MB.`);
      }

      const mimeType = file.type || "text/plain";
      let preview = "";

      if (attachmentKind === "video") {
        preview = `[Video attachment metadata only. No transcript or frame extraction is currently available. Name: ${file.name}; MIME: ${mimeType}; Size: ${file.size} bytes.]`;
      } else {
        let text: string;

        try {
          text = await file.text();
        } catch {
          throw new Error(`Failed to parse file \"${file.name}\".`);
        }

        preview = mimeType === "text/csv" || getExtension(file.name) === ".csv"
          ? buildCsvPreview(text)
          : buildTextPreview(text);
      }

      const providerRef: FileReference["providerRef"] = {};

      const [openaiFileId, googleFileUri] = await Promise.all([
        uploadToOpenAi(file).catch(() => undefined),
        uploadToGoogle(file).catch(() => undefined)
      ]);

      if (openaiFileId) {
        providerRef.openaiFileId = openaiFileId;
      }

      if (googleFileUri) {
        providerRef.googleFileUri = googleFileUri;
      }

      return {
        fileId: crypto.randomUUID(),
        fileName: file.name,
        mimeType,
        preview,
        attachmentKind,
        providerRef: Object.keys(providerRef).length ? providerRef : undefined
      };
    })
  );
}
