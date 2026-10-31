import type { FileReference } from "@/lib/providers/types";

/**
 * An upload-only composer turn carries no question. Confirm the current,
 * authenticated upload from its parsed evidence rather than asking a model to
 * infer its existence from a bare "[file]" message and prior failed replies.
 * This does not authorize retrieving any historical or unselected sources.
 */
export function verifiedFileOnlyPdfReceipt(
  message: string,
  fresh: readonly FileReference[],
  permittedPdfFileIds: ReadonlySet<string> | null | undefined,
): string | null {
  if (!/^\s*\[(?:file|files)\]\s*$/i.test(message) || fresh.length !== 1) return null;
  const file = fresh[0];
  if (file.mimeType !== "application/pdf" || !permittedPdfFileIds?.has(file.fileId)) return null;

  const name = JSON.stringify(file.fileName);
  const textLength = file.extractedText?.trim().length ?? 0;
  const chunks = file.extractedChunks?.filter(chunk => Boolean(chunk.text.trim())).length ?? 0;
  const readable = textLength > 0 || chunks > 0;
  const evidence = readable
    ? `I have readable extracted text${textLength ? ` (${textLength.toLocaleString("en-US")} characters` : " ("}${chunks ? `${textLength ? ", " : ""}${chunks} text chunk${chunks === 1 ? "" : "s"}` : ""}) from this PDF. ${file.extractionCoverage === "full" ? "Text extraction is marked complete; visual details have not been verified." : "Extraction coverage is incomplete, so I cannot claim every page or visual detail was captured."}`
    : "The PDF is saved, but no readable text was extracted. Its content needs additional inspection before I can assess it.";

  return `Received ${name}. ${evidence}\n\nWhat would you like me to do with it?`;
}
