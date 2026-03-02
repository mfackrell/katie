export type ParsedAttachment = {
  name: string;
  mimeType: string;
  text: string;
};

const MAX_FILES = 5;
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

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

export async function parseTextFiles(files: File[]): Promise<ParsedAttachment[]> {
  if (files.length > MAX_FILES) {
    throw new Error(`Too many files. Maximum allowed is ${MAX_FILES}.`);
  }

  const parsedAttachments = await Promise.all(
    files.map(async (file) => {
      if (!isAllowedFileType(file)) {
        throw new Error(`Unsupported file type for "${file.name}". Allowed types: txt, md, json, csv.`);
      }

      if (file.size > MAX_FILE_SIZE_BYTES) {
        throw new Error(`File "${file.name}" is too large. Maximum file size is 2MB.`);
      }

      const text = await file.text();

      return {
        name: file.name,
        mimeType: file.type || "text/plain",
        text
      };
    })
  );

  return parsedAttachments;
}
