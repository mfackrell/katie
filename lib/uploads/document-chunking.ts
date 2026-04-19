export type ExtractedTextChunk = {
  index: number;
  total: number;
  text: string;
  hash: string;
};

export const DEFAULT_CHUNK_MAX_CHARS = 12000;

function normalizeForHash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function splitTextByParagraph(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitOversizedParagraph(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) {
    return [paragraph];
  }

  const segments: string[] = [];
  let cursor = 0;
  while (cursor < paragraph.length) {
    const remaining = paragraph.length - cursor;
    if (remaining <= maxChars) {
      segments.push(paragraph.slice(cursor));
      break;
    }

    const window = paragraph.slice(cursor, cursor + maxChars);
    const lastSpace = window.lastIndexOf(" ");
    const splitAt = lastSpace > maxChars * 0.7 ? cursor + lastSpace : cursor + maxChars;
    segments.push(paragraph.slice(cursor, splitAt).trim());
    cursor = splitAt;
    while (paragraph[cursor] === " ") {
      cursor += 1;
    }
  }

  return segments.filter(Boolean);
}

export function chunkExtractedText(text: string, maxChars = DEFAULT_CHUNK_MAX_CHARS): ExtractedTextChunk[] {
  const paragraphs = splitTextByParagraph(text).flatMap((paragraph) => splitOversizedParagraph(paragraph, maxChars));

  if (paragraphs.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = paragraph;
      continue;
    }

    current = candidate;
  }

  if (current) {
    chunks.push(current);
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const normalized = normalizeForHash(chunk);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(chunk);
  }

  const total = deduped.length;
  return deduped.map((chunk, idx) => ({
    index: idx,
    total,
    text: chunk,
    hash: stableHash(normalizeForHash(chunk))
  }));
}
