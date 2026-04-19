import { FileReference } from "@/lib/providers/types";
import {
  parseTextFiles,
  validateFile
} from "@/lib/uploads/parse-text-files";
import { supportedExtensionsForError } from "@/lib/uploads/file-type-helpers";

const MAX_FILES = 5;
const MAX_VIDEO_FILE_SIZE_BYTES = 200 * 1024 * 1024;
const PREVIEW_MAX_CHARS = 2000;
const CSV_PREVIEW_MAX_ROWS = 50;

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

function isAllowedVideoFileType(file: File): boolean {
  if (ALLOWED_VIDEO_MIME_TYPES.has(file.type)) {
    return ALLOWED_VIDEO_EXTENSIONS.has(getExtension(file.name));
  }

  return false;
}

function supportedUploadTypesForError(): string {
  return `${supportedExtensionsForError()}, mp4, mov, webm, m4v`;
}

function assertSupportedUploadType(file: File): void {
  if (file.type.startsWith("video/")) {
    if (isAllowedVideoFileType(file)) {
      return;
    }

    throw new Error(`Unsupported file type for "${file.name}".`);
  }

  validateFile(file);
}

function buildCsvPreview(text: string): string {
  const rows = text.split(/\r?\n/).slice(0, CSV_PREVIEW_MAX_ROWS);
  const preview = rows.join("\n");
  return preview.length > PREVIEW_MAX_CHARS ? `${preview.slice(0, PREVIEW_MAX_CHARS)}…` : preview;
}

function buildTextPreview(text: string): string {
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
}

function buildParsedTextPreview(fileName: string, mimeType: string, text: string): string {
  return mimeType === "text/csv" || getExtension(fileName) === ".csv"
    ? buildCsvPreview(text)
    : buildTextPreview(text);
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

async function buildProviderRef(file: File): Promise<FileReference["providerRef"]> {
  const [openaiFileId, googleFileUri] = await Promise.all([
    uploadToOpenAi(file).catch(() => undefined),
    uploadToGoogle(file).catch(() => undefined)
  ]);

  const providerRef: FileReference["providerRef"] = {};

  if (openaiFileId) {
    providerRef.openaiFileId = openaiFileId;
  }

  if (googleFileUri) {
    providerRef.googleFileUri = googleFileUri;
  }

  return Object.keys(providerRef).length > 0 ? providerRef : undefined;
}

export async function buildFileReferences(files: File[]): Promise<FileReference[]> {
  if (files.length > MAX_FILES) {
    throw new Error(`Too many files. Maximum allowed is ${MAX_FILES}.`);
  }

  files.forEach((file) => {
    try {
      assertSupportedUploadType(file);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Unsupported file type")) {
        throw new Error(
          `Unsupported file type for "${file.name}". Allowed types: ${supportedUploadTypesForError()}.`
        );
      }

      throw error;
    }

    if (file.size === 0) {
      throw new Error(`File "${file.name}" is empty.`);
    }

    if (isAllowedVideoFileType(file) && file.size > MAX_VIDEO_FILE_SIZE_BYTES) {
      throw new Error(`File "${file.name}" is too large. Maximum video file size is 200MB.`);
    }
  });

  const textLikeFiles = files.filter((file) => !isAllowedVideoFileType(file));
  const parsedFiles = textLikeFiles.length > 0 ? await parseTextFiles(textLikeFiles) : [];
  const parsedByName = new Map(parsedFiles.map((parsed) => [parsed.name, parsed]));

  return Promise.all(
    files.map(async (file) => {
      const mimeType = file.type || "text/plain";
      const providerRef = await buildProviderRef(file);

      if (isAllowedVideoFileType(file)) {
        return {
          fileId: crypto.randomUUID(),
          fileName: file.name,
          mimeType,
          preview: `[Video attachment metadata only. No transcript or frame extraction is currently available. Name: ${file.name}; MIME: ${mimeType}; Size: ${file.size} bytes.]`,
          attachmentKind: "video",
          providerRef
        } satisfies FileReference;
      }

      const parsed = parsedByName.get(file.name);
      if (!parsed) {
        throw new Error(`Failed to parse file "${file.name}".`);
      }

      return {
        fileId: crypto.randomUUID(),
        fileName: file.name,
        mimeType,
        preview: buildParsedTextPreview(file.name, mimeType, parsed.text),
        extractedText: parsed.text,
        attachmentKind: "text",
        providerRef
      } satisfies FileReference;
    })
  );
}
