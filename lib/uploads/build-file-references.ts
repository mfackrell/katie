import { FileReference } from "@/lib/providers/types";
import { ingestFile } from "@/lib/uploads/ingest-file";
import { getFileExtension } from "@/lib/uploads/file-type-helpers";

const MAX_FILES = 5;
const MAX_VIDEO_FILE_SIZE_BYTES = 200 * 1024 * 1024;
const ALLOWED_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"]);
const ALLOWED_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v"]);

type UploadDeps = {
  uploadToOpenAi: (file: File) => Promise<string | undefined>;
  uploadToGoogle: (file: File) => Promise<string | undefined>;
};

function isAllowedVideoFileType(file: File): boolean {
  if (ALLOWED_VIDEO_MIME_TYPES.has(file.type)) {
    return ALLOWED_VIDEO_EXTENSIONS.has(getFileExtension(file.name));
  }

  return false;
}

async function uploadToOpenAiDefault(file: File): Promise<string | undefined> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return undefined;

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey, fetch: globalThis.fetch.bind(globalThis) });
  const uploaded = await client.files.create({ file, purpose: "user_data" });
  return uploaded.id;
}

async function uploadToGoogleDefault(file: File): Promise<string | undefined> {
  const apiKey = process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) return undefined;

  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey });
  const upload = await client.files.upload({ file, config: { mimeType: file.type || undefined } });
  return upload.uri ?? undefined;
}

let UPLOAD_DEPS: UploadDeps = { uploadToOpenAi: uploadToOpenAiDefault, uploadToGoogle: uploadToGoogleDefault };

export function __setUploadDepsForTests(overrides: Partial<UploadDeps>): void {
  UPLOAD_DEPS = { ...UPLOAD_DEPS, ...overrides };
}

export async function buildFileReferences(files: File[]): Promise<FileReference[]> {
  if (files.length > MAX_FILES) {
    throw new Error(`Too many files. Maximum allowed is ${MAX_FILES}.`);
  }

  return Promise.all(
    files.map(async (file) => {
      if (file.size === 0) {
        throw new Error(`File "${file.name}" is empty.`);
      }

      if (file.type.startsWith("video/") && !isAllowedVideoFileType(file)) {
        throw new Error(
          `Unsupported file type for "${file.name}". Allowed types: txt, md, json, csv, xml, html, docx, doc, xlsx, xls, pptx, ppt, eml, msg, pdf, png, jpg, jpeg, webp, mp4, mov, webm, m4v.`
        );
      }

      if (isAllowedVideoFileType(file)) {
        if (file.size > MAX_VIDEO_FILE_SIZE_BYTES) {
          throw new Error(`File "${file.name}" is too large. Maximum video file size is 200MB.`);
        }

        const providerRef: FileReference["providerRef"] = {};
        const warnings: string[] = [];

        const [openaiUpload, googleUpload] = await Promise.allSettled([UPLOAD_DEPS.uploadToOpenAi(file), UPLOAD_DEPS.uploadToGoogle(file)]);
        if (openaiUpload.status === "fulfilled" && openaiUpload.value) providerRef.openaiFileId = openaiUpload.value;
        if (googleUpload.status === "fulfilled" && googleUpload.value) providerRef.googleFileUri = googleUpload.value;
        if (openaiUpload.status === "rejected") warnings.push("OpenAI native file upload failed; using extracted text fallback.");
        if (googleUpload.status === "rejected") warnings.push("Google native file upload failed; using extracted text fallback.");

        return {
          fileId: crypto.randomUUID(),
          fileName: file.name,
          mimeType: file.type || "video/mp4",
          preview: `[Video attachment metadata only. No transcript or frame extraction is currently available. Name: ${file.name}; MIME: ${file.type || "video/mp4"}; Size: ${file.size} bytes.]`,
          sourceFormat: "video",
          attachmentKind: "video",
          providerRef: Object.keys(providerRef).length ? providerRef : undefined,
          parseWarnings: warnings.length ? warnings : undefined,
          ingestionQuality: "medium"
        };
      }

      const ingested = await ingestFile(file);
      const providerRef: FileReference["providerRef"] = {};
      const warnings = [...(ingested.parseWarnings ?? [])];

      const [openaiUpload, googleUpload] = await Promise.allSettled([UPLOAD_DEPS.uploadToOpenAi(file), UPLOAD_DEPS.uploadToGoogle(file)]);
      if (openaiUpload.status === "fulfilled" && openaiUpload.value) providerRef.openaiFileId = openaiUpload.value;
      if (googleUpload.status === "fulfilled" && googleUpload.value) providerRef.googleFileUri = googleUpload.value;
      if (openaiUpload.status === "rejected") warnings.push("OpenAI native file upload failed; using extracted text fallback.");
      if (googleUpload.status === "rejected") warnings.push("Google native file upload failed; using extracted text fallback.");

      return {
        fileId: crypto.randomUUID(),
        fileName: ingested.fileName,
        mimeType: ingested.mimeType,
        preview: ingested.preview,
        extractedText: ingested.extractedText,
        sourceFormat: ingested.sourceFormat,
        attachmentKind: ingested.attachmentKind,
        structuredData: ingested.structuredData,
        parseWarnings: warnings.length ? warnings : undefined,
        ingestionQuality: ingested.ingestionQuality,
        providerRef: Object.keys(providerRef).length ? providerRef : undefined
      };
    })
  );
}
