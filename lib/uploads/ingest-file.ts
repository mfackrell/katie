import { detectFileType, supportedExtensionsForError } from "@/lib/uploads/file-type-helpers";
import { parseEmail } from "@/lib/uploads/parsers/email";
import { parseExcel } from "@/lib/uploads/parsers/excel";
import { parseImage } from "@/lib/uploads/parsers/image";
import { parsePdf } from "@/lib/uploads/parsers/pdf";
import { parsePowerPoint } from "@/lib/uploads/parsers/powerpoint";
import { parseTextLike } from "@/lib/uploads/parsers/text";
import { parseWord } from "@/lib/uploads/parsers/word";
import { type IngestedFile } from "@/lib/uploads/parsers/shared";

const MAX_TEXT_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_FILE_SIZE_BYTES = 8 * 1024 * 1024;

export function validateFileForIngestion(file: File) {
  const fileType = detectFileType(file);

  if (!fileType) {
    throw new Error(`Unsupported file type for "${file.name}". Supported extensions: ${supportedExtensionsForError()}.`);
  }

  const sizeLimitBytes = ["text", "json", "xml", "html"].includes(fileType.sourceFormat)
    ? MAX_TEXT_FILE_SIZE_BYTES
    : MAX_BINARY_FILE_SIZE_BYTES;

  if (file.size > sizeLimitBytes) {
    const limitMb = Math.floor(sizeLimitBytes / (1024 * 1024));
    throw new Error(`File "${file.name}" is too large. Maximum file size for this type is ${limitMb}MB.`);
  }

  return fileType;
}

export async function ingestFile(file: File): Promise<IngestedFile> {
  const fileType = validateFileForIngestion(file);
  if (!fileType) {
    throw new Error(`Unsupported file type for "${file.name}". Supported extensions: ${supportedExtensionsForError()}.`);
  }

  const context = {
    file,
    extension: file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "",
    mimeType: file.type || "application/octet-stream"
  };

  switch (fileType.sourceFormat) {
    case "text":
    case "json":
    case "html":
    case "xml":
      return parseTextLike(context);
    case "word":
      return parseWord(context);
    case "excel":
      return parseExcel(context);
    case "powerpoint":
      return parsePowerPoint(context);
    case "email":
      return parseEmail(context);
    case "image":
      return parseImage(context);
    case "pdf":
      return parsePdf(context);
    default:
      return {
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        sourceFormat: "unknown",
        attachmentKind: "file",
        preview: `[No parser available for ${file.name}]`,
        parseWarnings: ["No parser available for this file type."],
        ingestionQuality: "failed"
      };
  }
}
