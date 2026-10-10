import { getLongTermMemory, setLongTermMemory } from "@/lib/data/persistence-store";

// Explicit saves are not routed through the ordinary memory editor. That editor
// may legitimately return no_change for everyday conversation, but an explicit
// document-save request requires a dedicated, verifiable extraction attempt.
const MODEL = "gpt-4o-mini";
const CHUNK_CHARS = 8500;
const MAX_FACTS_PER_CHUNK = 22;
const MAX_DOCUMENT_FACTS = 150;
const BATCH_SIZE = 3;

type Category = "fact" | "preference" | "relationship" | "goal" | "decision" | "constraint" | "pattern";
const CATEGORIES: Category[] = ["fact", "preference", "relationship", "goal", "decision", "constraint", "pattern"];

type ExtractedFact = {
  key: string;
  category: Category;
  value: string;
  evidence: string;
};
type StoredFact = {
  key: string;
  category: Category;
  value: string;
  source: "user-stated";
  confidence: "high";
  evidenceMessageIds: string[];
  lastConfirmedAt: string;
};
type Client = {
  chat: {
    completions: {
      create(params: {
        model: string;
        temperature: number;
        response_format: { type: "json_object" };
        messages: Array<{ role: "system" | "user"; content: string }>;
      }): Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>;
    };
  };
};

export type ExplicitFactExtractionResult = {
  factsSaved: number;
  chunksProcessed: number;
  chunksFailed: number;
  available: boolean;
};

function defaultClient(): Client | null {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: OpenAI } = require("openai") as {
      default: new (params: { apiKey: string }) => Client;
    };
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch {
    return null;
  }
}

function extractionClient(): Client | null {
  return (globalThis as { __KATIE_EXPLICIT_FACT_OPENAI_CLIENT__?: Client | null })
    .__KATIE_EXPLICIT_FACT_OPENAI_CLIENT__ ?? defaultClient();
}

export function splitExplicitMemoryDocument(content: string): string[] {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    if (content.length - cursor <= CHUNK_CHARS) {
      chunks.push(content.slice(cursor));
      break;
    }
    const target = cursor + CHUNK_CHARS;
    // Respect line boundaries where possible without omitting any character.
    const newline = content.lastIndexOf("\n", target);
    const end = newline > cursor + CHUNK_CHARS / 2 ? newline + 1 : target;
    chunks.push(content.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function parseExtractedFacts(raw: string, source: string): ExtractedFact[] {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !("facts" in parsed)) {
    throw new Error("Missing facts array");
  }
  const facts = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) throw new Error("Invalid facts array");
  const result: ExtractedFact[] = [];
  const seen = new Set<string>();
  for (const candidate of facts.slice(0, MAX_FACTS_PER_CHUNK)) {
    if (!candidate || typeof candidate !== "object") continue;
    const fact = candidate as Record<string, unknown>;
    if (typeof fact.key !== "string" || typeof fact.value !== "string" ||
        typeof fact.evidence !== "string" || !CATEGORIES.includes(fact.category as Category)) continue;
    const key = fact.key.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 90);
    const value = fact.value.trim();
    const evidence = fact.evidence.trim();
    // The source quote must actually occur in this chunk. Unsupported claims
    // are rejected instead of silently becoming user-stated memory.
    if (!key || !value || value.length > 900 ||
        evidence.length < 4 || evidence.length > 500 ||
        !normalized(source).includes(normalized(evidence))) continue;
    const signature = normalized(value);
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push({ key, category: fact.category as Category, value, evidence });
  }
  return result;
}

async function extractChunk(client: Client, text: string, part: number, total: number): Promise<ExtractedFact[]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await client.chat.completions.create({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "Extract durable structured knowledge from the USER'S explicit long-term reference document.",
              "Return a JSON object with a facts array; NEVER return action:no_change.",
              "Capture specific roles, employers described generically, engagement scope, outcomes, transaction size, dates, credentials, industries, skills, preferences, and explicit qualifications when supported.",
              "For substantive chunks, return approximately 10-20 distinct, useful facts, up to 22. Preserve numbers, dates, qualifiers and attribution precisely.",
              "Do not conflate enterprise valuation with revenue, company revenue with transaction value, or user duties with somebody else's.",
              "Do not invent, extrapolate, duplicate, or promote speculation into fact. Keep dated historical claims in historical language.",
              "Each fact MUST contain an exact short evidence quote copied verbatim from the provided chunk (4-500 characters).",
              "Each key should be a meaningful stable dotted identifier; use one independent claim or closely related bundle per fact.",
              "Allowed category values: fact, preference, relationship, goal, decision, constraint, pattern.",
              'Return ONLY {"facts":[{"key":"career.example","category":"fact","value":"Precise self-contained fact","evidence":"Exact words from source"}]}.',
              "No markdown, no other keys. This is an extraction task even when a document is already stored.",
            ].join("\n"),
          },
          {
            role: "user",
            content: "Reference document part " + part + " of " + total + ":\n\n" + text +
              (attempt ? "\n\nPREVIOUS EXTRACTION WAS INVALID OR EMPTY. Provide only valid, quote-grounded facts." : ""),
          },
        ],
      });
      const raw = response.choices?.[0]?.message?.content;
      if (!raw) throw new Error("Empty extraction response");
      const extracted = parseExtractedFacts(raw, text);
      if (extracted.length === 0) throw new Error("No quote-grounded facts");
      return extracted;
    } catch (error) {
      if (attempt === 1) {
        console.error("[ExplicitFactExtractor] Chunk failed", {
          part, total, error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return [];
}

function existingEntries(content: Record<string, unknown>): StoredFact[] {
  return Array.isArray(content.entries)
    ? content.entries.filter((entry): entry is StoredFact =>
        Boolean(entry && typeof entry === "object" && typeof entry.key === "string"))
    : [];
}

export async function extractAndSaveExplicitFacts(
  actorId: string,
  chatId: string,
  messageId: string,
  message: string,
): Promise<ExplicitFactExtractionResult> {
  const client = extractionClient();
  if (!client) return { factsSaved: 0, chunksProcessed: 0, chunksFailed: 1, available: false };

  // Exclude the command itself from the source text when it is a standalone
  // header; the original full user message remains stored verbatim.
  const source = message.replace(/^\s*(?:retain|save|store|remember)\s+this\s+in\s+(?:your\s+)?(?:long[- ]term\s+)?memory\s*:\s*/i, "");
  const chunks = splitExplicitMemoryDocument(source);
  const allFacts: ExtractedFact[] = [];
  let failed = 0;
  for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
    const batch = chunks.slice(start, start + BATCH_SIZE);
    const results = await Promise.all(batch.map((chunk, offset) =>
      extractChunk(client, chunk, start + offset + 1, chunks.length)));
    for (const result of results) {
      if (!result.length) failed += 1;
      allFacts.push(...result);
    }
  }

  const now = new Date().toISOString();
  const seen = new Set<string>();
  const additions: StoredFact[] = [];
  for (const fact of allFacts) {
    if (additions.length >= MAX_DOCUMENT_FACTS) {
      failed += 1; // never claim exhaustive processing after a truncation
      break;
    }
    const signature = normalized(fact.value);
    if (seen.has(signature)) continue;
    seen.add(signature);
    const uniqueKey = "reference." + messageId + "." + additions.length + "." + fact.key;
    additions.push({
      key: uniqueKey,
      category: fact.category,
      value: fact.value,
      source: "user-stated",
      confidence: "high",
      evidenceMessageIds: [messageId],
      lastConfirmedAt: now,
    });
  }
  if (additions.length) {
    const current = await getLongTermMemory(actorId, chatId);
    const entries = existingEntries(current);
    const prefix = "reference." + messageId + ".";
    const nextEntries = entries.filter(entry => !entry.key.startsWith(prefix)).concat(additions);
    await setLongTermMemory(actorId, chatId, {
      version: 3,
      purpose: typeof current.purpose === "string" ? current.purpose : "Actor-wide durable memory",
      entries: nextEntries,
    });
    const persisted = await getLongTermMemory(actorId, chatId);
    const confirmed = existingEntries(persisted).filter(e => e.key.startsWith(prefix));
    if (confirmed.length !== additions.length) throw new Error("Structured fact write verification failed");
  }

  console.log("[ExplicitFactExtractor] Completed", {
    actorId, chatId, sourceMessageId: messageId, factsSaved: additions.length,
    chunksProcessed: chunks.length, chunksFailed: failed,
  });
  return {
    factsSaved: additions.length,
    chunksProcessed: chunks.length,
    chunksFailed: failed,
    available: true,
  };
}
