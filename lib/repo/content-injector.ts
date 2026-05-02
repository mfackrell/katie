import {
  getRepoFile,
  listRepoFiles,
} from "./repo-access";

type Chunk = {
  path: string;
  content: string;
  size: number;
  lineStart: number;
  lineEnd: number;
  score: number;
  explicitPathHit: boolean;
};

const MAX_INJECTED_CHARS = 20_000;
const CHUNK_SIZE_LINES = 150;
const CHUNK_OVERLAP_LINES = 25;
const MAX_CHUNKS_PER_FILE = 4;

function redactSecrets(content: string): string {
  return content
    .replace(/(api[_-]?key\s*[:=]\s*["']?)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/(password\s*[:=]\s*["']?)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/(token\s*[:=]\s*["']?)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/(secret\s*[:=]\s*["']?)[^\s"'`]+/gi, "$1[REDACTED]");
}

function parseHints(userMessage: string): string[] {
  const hints = new Set<string>();
  const pathPattern = /\b(?:lib|app|prompts|src|tests|packages)\/[\w./-]+\b/gi;
  const filePattern = /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml)\b/gi;

  for (const match of userMessage.match(pathPattern) ?? []) {
    hints.add(match.replace(/^["'`(]+|["'`),.]+$/g, ""));
  }

  for (const match of userMessage.match(filePattern) ?? []) {
    hints.add(match.replace(/^["'`(]+|["'`),.]+$/g, ""));
  }

  if (/\bintent\b/i.test(userMessage) || /\bclassifier\b/i.test(userMessage)) {
    hints.add("lib/router/model-intent.ts");
  }
  if (/\bprompt\b/i.test(userMessage)) {
    hints.add("prompts/");
  }

  return Array.from(hints);
}

function parseFunctionLikeHints(userMessage: string): string[] {
  const names = new Set<string>();
  const camelCaseMatches = userMessage.match(/\b[a-z][a-zA-Z0-9]*\b/g) ?? [];

  for (const token of camelCaseMatches) {
    if (/[A-Z]/.test(token) && token.length >= 4) {
      names.add(token.toLowerCase());
    }
  }

  for (const match of userMessage.match(/\b(?:function|class|method)\s+([A-Za-z_][A-Za-z0-9_]*)/gi) ?? []) {
    const [, name = ""] = /\b(?:function|class|method)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(match) ?? [];
    if (name) {
      names.add(name.toLowerCase());
    }
  }

  return Array.from(names);
}

function keywordScore(userMessage: string, path: string, preview: string): number {
  const keywords = Array.from(
    new Set(
      userMessage
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 3)
    )
  );

  if (keywords.length === 0) {
    return 1;
  }

  const normalizedPath = path.toLowerCase();
  const normalizedPreview = preview.toLowerCase();
  return keywords.reduce((score, keyword) => {
    const pathHit = normalizedPath.includes(keyword) ? 2 : 0;
    const previewHit = normalizedPreview.includes(keyword) ? 1 : 0;
    return score + pathHit + previewHit;
  }, 0);
}

function chunkContentByLines(path: string, content: string, size: number): Omit<Chunk, "score" | "explicitPathHit">[] {
  const lines = content.split("\n");

  if (lines.length <= CHUNK_SIZE_LINES) {
    return [
      {
        path,
        content,
        size,
        lineStart: 1,
        lineEnd: lines.length,
      },
    ];
  }

  const chunks: Omit<Chunk, "score" | "explicitPathHit">[] = [];
  const step = Math.max(1, CHUNK_SIZE_LINES - CHUNK_OVERLAP_LINES);

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + CHUNK_SIZE_LINES);
    const chunkLines = lines.slice(start, end);

    chunks.push({
      path,
      content: chunkLines.join("\n"),
      size,
      lineStart: start + 1,
      lineEnd: end,
    });

    if (end >= lines.length) {
      break;
    }
  }

  return chunks;
}

function isExplicitPathHit(path: string, explicitHints: string[]): boolean {
  const normalizedPath = path.toLowerCase();
  return explicitHints.some((hint) => {
    const normalizedHint = hint.toLowerCase();
    return normalizedPath === normalizedHint || normalizedPath.endsWith(normalizedHint) || normalizedPath.includes(normalizedHint);
  });
}

function scoreChunk({
  chunk,
  userMessage,
  explicitPathHints,
  functionHints,
}: {
  chunk: Omit<Chunk, "score" | "explicitPathHit">;
  userMessage: string;
  explicitPathHints: string[];
  functionHints: string[];
}): Chunk {
  const explicitPathHit = isExplicitPathHit(chunk.path, explicitPathHints);
  const baseKeywordScore = keywordScore(userMessage, chunk.path, chunk.content);
  const normalizedContent = chunk.content.toLowerCase();
  const functionBoost = functionHints.reduce((total, name) => (normalizedContent.includes(name) ? total + 8 : total), 0);
  const routingTerms = ["route", "classifier", "router", "prompt", "injection", "repo"];
  const routingBoost = routingTerms.reduce((total, term) => (normalizedContent.includes(term) ? total + 1 : total), 0);
  const explicitBoost = explicitPathHit ? 100 : 0;

  return {
    ...chunk,
    score: baseKeywordScore + functionBoost + routingBoost + explicitBoost,
    explicitPathHit,
  };
}

export async function injectRelevantContents(userMessage: string, repoId: string, maxFiles = 5): Promise<string> {

  const hints = parseHints(userMessage);
  const explicitPathHints = hints.filter((hint) => hint.includes("/") || /\.[a-z0-9]+$/i.test(hint));
  const functionHints = parseFunctionLikeHints(userMessage);
  const allPaths = (await listRepoFiles(repoId)).filter((f) => f.kind === "file").map((f) => f.path);

  const explicitCandidates = allPaths.filter((path) => isExplicitPathHit(path, explicitPathHints));

  let secondaryCandidates: string[] = [];
  if (hints.length) {
    const hintLower = hints.map((hint) => hint.toLowerCase());
    secondaryCandidates = allPaths.filter(
      (path) => hintLower.some((hint) => path.toLowerCase().includes(hint)) && !explicitCandidates.includes(path)
    );
  }

  if (!secondaryCandidates.length) {
    const defaults = ["lib/", "app/api/", "prompts/"];
    secondaryCandidates = allPaths.filter((path) => defaults.some((prefix) => path.startsWith(prefix)) && !explicitCandidates.includes(path));
  }

  const maxFilesCap = Math.max(1, Math.min(maxFiles, 5));
  const candidates = [...explicitCandidates, ...secondaryCandidates].slice(0, maxFilesCap * 4);

  if (candidates.length > 5) {
    console.warn("[Repo Injector] attempted more than 5 files", { repoId, attempted: candidates.length });
  }

  const chunks: Chunk[] = [];
  const issues: string[] = [];

  for (const path of candidates) {
    try {
      const startedAt = Date.now();
      const file = await getRepoFile(repoId, path);
      const scoredChunks = chunkContentByLines(path, redactSecrets(file.content), file.size)
        .map((chunk) =>
          scoreChunk({
            chunk,
            userMessage,
            explicitPathHints,
            functionHints,
          })
        )
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_CHUNKS_PER_FILE);

      chunks.push(...scoredChunks);

      console.log("[Repo Injector] fetch_latency_ms", { repoId, path, latencyMs: Date.now() - startedAt });
    } catch (error) {
      console.error("[Repo Injector] failed to fetch path", {
        repoId,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      issues.push(`[REPO ACCESS ISSUE: Could not fetch ${path}. Paste manually?]`);
    }
  }

  const selectedChunks = chunks
    .sort((a, b) => {
      if (a.explicitPathHit !== b.explicitPathHit) {
        return a.explicitPathHit ? -1 : 1;
      }

      return b.score - a.score;
    })
    .slice(0, maxFilesCap * MAX_CHUNKS_PER_FILE);

  const header = `[REPO CONTEXT: active repo binding]\n`;
  let output = header;
  const truncated: string[] = [];

  for (const chunk of selectedChunks) {
    const lineRange = `Lines: ${chunk.lineStart}-${chunk.lineEnd}`;
    const block = `File: ${chunk.path} (${lineRange} | Size: ${chunk.size})\n\`\`\`\n${chunk.content}\n---\n\`\`\`\n`;

    if ((output + block).length > MAX_INJECTED_CHARS) {
      truncated.push(`${chunk.path}:${chunk.lineStart}-${chunk.lineEnd}`);
      continue;
    }

    output += block;
  }

  if (issues.length) {
    output += `${issues.join("\n")}\n`;
  }

  if (truncated.length) {
    output += `${truncated.map((entry) => `Truncated: ${entry} omitted for brevity.`).join("\n")}\n`;
  }

  if (selectedChunks.length === 0 && issues.length === 0) {
    output += "[REPO ACCESS ISSUE: No relevant source files found. Paste manually?]\n";
  }

  return output;
}

