export type JsonRecord = Record<string, unknown>;

export function parseIntermediateMemoryDraft(draft: string): JsonRecord {
  let parsed: unknown;

  try {
    parsed = JSON.parse(draft);
  } catch {
    throw new Error("Intermediate memory must be valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Intermediate memory content must be a JSON object.");
  }

  return parsed as JsonRecord;
}

export function stringifyIntermediateMemoryContent(content: JsonRecord): string {
  return JSON.stringify(content, null, 2);
}
