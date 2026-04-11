export type SourceFormat = "text" | "word" | "excel" | "pdf";

type FileTypeDefinition = {
  sourceFormat: SourceFormat;
  extensions: string[];
  mimeTypes: string[];
  isLegacy?: boolean;
};

const FILE_TYPE_DEFINITIONS: FileTypeDefinition[] = [
  {
    sourceFormat: "text",
    extensions: [".txt", ".md", ".json", ".csv"],
    mimeTypes: ["text/plain", "text/markdown", "application/json", "text/csv"]
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

export const SUPPORTED_EXTENSIONS = Array.from(
  new Set(FILE_TYPE_DEFINITIONS.flatMap((definition) => definition.extensions))
);

export function getFileExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf(".");
  if (lastDotIndex < 0) {
    return "";
  }

  return fileName.slice(lastDotIndex).toLowerCase();
}

export function detectFileType(file: File): FileTypeDefinition | undefined {
  const mimeType = file.type.trim().toLowerCase();
  if (mimeType) {
    const mimeMatch = MIME_TO_TYPE.get(mimeType);
    if (mimeMatch) {
      return mimeMatch;
    }
  }

  return EXT_TO_TYPE.get(getFileExtension(file.name));
}

export function isTextSourceFormat(sourceFormat: SourceFormat): boolean {
  return sourceFormat === "text";
}

export function supportedExtensionsForError(): string {
  return SUPPORTED_EXTENSIONS.map((extension) => extension.replace(/^\./, "")).join(", ");
}

export function isLegacyWordType(definition: FileTypeDefinition): boolean {
  return Boolean(definition.isLegacy && definition.sourceFormat === "word");
}
