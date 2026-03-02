import { FileReference } from "@/lib/providers/types";

const MAX_FILES = 5;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const PREVIEW_MAX_CHARS = 2000;
const CSV_PREVIEW_MAX_ROWS = 50;

const ALLOWED_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv"
]);

const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".json", ".csv"]);

function getExtension(name: string): string {
  const lastDotIndex = name.lastIndexOf(".");
  if (lastDotIndex < 0) {
    return "";
  }

  return name.slice(lastDotIndex).toLowerCase();
}

function isAllowedFileType(file: File): boolean {
  if (ALLOWED_MIME_TYPES.has(file.type)) {
    return true;
  }

  return ALLOWED_EXTENSIONS.has(getExtension(file.name));
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
  void file;
  // Hook point: wire provider-native file upload here when OPENAI_API_KEY is available.
  return undefined;
}

async function uploadToGoogle(file: File): Promise<string | undefined> {
  void file;
  // Hook point: wire provider-native file upload here when GOOGLE_API_KEY is available.
  return undefined;
}

export async function buildFileReferences(files: File[]): Promise<FileReference[]> {
  if (files.length > MAX_FILES) {
    throw new Error(`Too many files. Maximum allowed is ${MAX_FILES}.`);
  }

  return Promise.all(
    files.map(async (file) => {
      if (!isAllowedFileType(file)) {
        throw new Error(`Unsupported file type for \"${file.name}\". Allowed types: txt, md, json, csv.`);
      }

      if (file.size === 0) {
        throw new Error(`File \"${file.name}\" is empty.`);
      }

      if (file.size > MAX_FILE_SIZE_BYTES) {
        throw new Error(`File \"${file.name}\" is too large. Maximum file size is 10MB.`);
      }

      let text: string;

      try {
        text = await file.text();
      } catch {
        throw new Error(`Failed to parse file \"${file.name}\".`);
      }

      const mimeType = file.type || "text/plain";
      const preview = mimeType === "text/csv" || getExtension(file.name) === ".csv"
        ? buildCsvPreview(text)
        : buildTextPreview(text);

      const providerRef: FileReference["providerRef"] = {};

      const [openaiFileId, googleFileUri] = await Promise.all([
        uploadToOpenAi(file),
        uploadToGoogle(file)
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
        providerRef: Object.keys(providerRef).length ? providerRef : undefined
      };
    })
  );
}
