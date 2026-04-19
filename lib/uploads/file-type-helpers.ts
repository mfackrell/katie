export type SourceFormat = "text" | "word" | "excel" | "pdf" | "powerpoint" | "email" | "image" | "html" | "xml" | "json";

export type FileTypeDefinition = {
  sourceFormat: SourceFormat;
  extensions: string[];
  mimeTypes: string[];
  isLegacy?: boolean;
};

const FILE_TYPE_DEFINITIONS: FileTypeDefinition[] = [
  {
    sourceFormat: "text",
    extensions: [".txt", ".md", ".csv"],
    mimeTypes: ["text/plain", "text/markdown", "text/csv"]
  },
  {
    sourceFormat: "json",
    extensions: [".json"],
    mimeTypes: ["application/json", "text/json"]
  },
  {
    sourceFormat: "xml",
    extensions: [".xml"],
    mimeTypes: ["application/xml", "text/xml"]
  },
  {
    sourceFormat: "html",
    extensions: [".html", ".htm"],
    mimeTypes: ["text/html", "application/xhtml+xml"]
  },
  {
    sourceFormat: "word",
    extensions: [".docx"],
    mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
  },
  {
    sourceFormat: "word",
    extensions: [".doc"],
    mimeTypes: ["application/msword"],
    isLegacy: true
  },
  {
    sourceFormat: "excel",
    extensions: [".xlsx"],
    mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]
  },
  {
    sourceFormat: "excel",
    extensions: [".xls"],
    mimeTypes: ["application/vnd.ms-excel"]
  },
  {
    sourceFormat: "powerpoint",
    extensions: [".pptx"],
    mimeTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"]
  },
  {
    sourceFormat: "powerpoint",
    extensions: [".ppt"],
    mimeTypes: ["application/vnd.ms-powerpoint"],
    isLegacy: true
  },
  {
    sourceFormat: "email",
    extensions: [".eml"],
    mimeTypes: ["message/rfc822"]
  },
  {
    sourceFormat: "email",
    extensions: [".msg"],
    mimeTypes: ["application/vnd.ms-outlook"],
    isLegacy: true
  },
  {
    sourceFormat: "image",
    extensions: [".png", ".jpg", ".jpeg", ".webp"],
    mimeTypes: ["image/png", "image/jpeg", "image/webp"]
  },
  {
    sourceFormat: "pdf",
    extensions: [".pdf"],
    mimeTypes: ["application/pdf"]
  }
];

const MIME_TO_TYPE = new Map<string, FileTypeDefinition>();
const EXT_TO_TYPE = new Map<string, FileTypeDefinition>();

for (const definition of FILE_TYPE_DEFINITIONS) {
  for (const mimeType of definition.mimeTypes) {
    MIME_TO_TYPE.set(mimeType, definition);
  }
  for (const extension of definition.extensions) {
    EXT_TO_TYPE.set(extension, definition);
  }
}

export const SUPPORTED_EXTENSIONS = Array.from(new Set(FILE_TYPE_DEFINITIONS.flatMap((d) => d.extensions)));

export function getFileExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf(".");
  if (lastDotIndex < 0) return "";
  return fileName.slice(lastDotIndex).toLowerCase();
}

export function detectFileType(file: File): FileTypeDefinition | undefined {
  const mimeType = file.type.trim().toLowerCase();
  if (mimeType) {
    const byMime = MIME_TO_TYPE.get(mimeType);
    if (byMime) return byMime;
  }
  return EXT_TO_TYPE.get(getFileExtension(file.name));
}

export function isTextSourceFormat(sourceFormat: SourceFormat): boolean {
  return ["text", "json", "xml", "html", "word", "excel", "powerpoint", "email", "pdf"].includes(sourceFormat);
}

export function supportedExtensionsForError(): string {
  return SUPPORTED_EXTENSIONS.map((extension) => extension.replace(/^\./, "")).join(", ");
}

export function isLegacyWordType(definition: FileTypeDefinition): boolean {
  return Boolean(definition.isLegacy && definition.sourceFormat === "word");
}
