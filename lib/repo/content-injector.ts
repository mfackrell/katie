import { Octokit } from "@octokit/rest";
import { buildLikelyCandidatePaths, resolveRepoFile } from "./retrieval-strategy";

type RepoBinding = {
  owner: string;
  repo: string;
  defaultBranch: string;
};

type CachedFile = {
  content: string;
  size: number;
  fetchedAt: number;
};

type Chunk = {
  path: string;
  content: string;
  size: number;
  lineStart: number;
  lineEnd: number;
  score: number;
  explicitPathHit: boolean;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_INJECTED_CHARS = 20_000;
const MAX_CALLS_PER_MINUTE = 10;
const CHUNK_SIZE_LINES = 150;
const CHUNK_OVERLAP_LINES = 25;
const MAX_CHUNKS_PER_FILE = 4;

const cache = new Map<string, CachedFile>();
const repoBindings = new Map<string, RepoBinding>();
const requestTimestamps: number[] = [];

let octokitFactory = () =>
  new Octokit({
    auth: process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT ?? process.env.GH_TOKEN,
  });

function buildCacheKey(repoId: string, path: string): string {
  return `${repoId}:${path.toLowerCase()}`;
}

function redactSecrets(content: string): string {
  return content
    .replace(/(api[_-]?key\s*[:=]\s*["']?)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/(password\s*[:=]\s*["']?)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/(token\s*[:=]\s*["']?)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/(secret\s*[:=]\s*["']?)[^\s"'`]+/gi, "$1[REDACTED]");
}

function parseHints(userMessage: string): string[] {
  const hints = new Set<string>();
  const pathPattern = /\b(?:lib|app|prompts|src|tests|packages|components|types)\/[\w./-]+\b/gi;
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
        .filter((token) => token.length >= 3),
    ),
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

async function listTextPaths(binding: RepoBinding): Promise<string[]> {
  const octokit = octokitFactory();
  const ref = await octokit.git.getRef({ owner: binding.owner, repo: binding.repo, ref: `heads/${binding.defaultBranch}` });
  const tree = await octokit.git.getTree({
    owner: binding.owner,
    repo: binding.repo,
    tree_sha: ref.data.object.sha,
    recursive: "1",
  });

  return (tree.data.tree ?? [])
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
    .map((entry) => entry.path as string)
    .filter((path) => /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml)$/i.test(path));
}

function enforceRateLimit(): boolean {
  const now = Date.now();
  while (requestTimestamps.length && now - requestTimestamps[0] > 60_000) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= MAX_CALLS_PER_MINUTE) {
    return false;
  }

  requestTimestamps.push(now);
  return true;
}

async function getFileContent(repoId: string, binding: RepoBinding, path: string): Promise<{ content: string; size: number }> {
  const key = buildCacheKey(repoId, path);
  const cached = cache.get(key);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { content: cached.content, size: cached.size };
  }

  if (!enforceRateLimit()) {
    throw new Error("rate_limit_local");
  }

  const octokit = octokitFactory();
  const response = await octokit.repos.getContent({
    owner: binding.owner,
    repo: binding.repo,
    path,
    ref: binding.defaultBranch,
  });

  if (Array.isArray(response.data) || response.data.type !== "file" || response.data.encoding !== "base64") {
    throw new Error("invalid_file_payload");
  }

  const decoded = Buffer.from(response.data.content, "base64").toString("utf8");
  const redacted = redactSecrets(decoded);
  const size = response.data.size ?? Buffer.byteLength(redacted, "utf8");
  cache.set(key, { content: redacted, size, fetchedAt: Date.now() });

  return { content: redacted, size };
}

export function registerRepoBinding(repoId: string, repositoryFullName: string, defaultBranch = "main"): void {
  const [owner, repo] = repositoryFullName.split("/");
  if (!owner || !repo) {
    return;
  }

  repoBindings.set(repoId, { owner, repo, defaultBranch });
}

function normalizeSearchMatches(paths: string[], hint: string): string[] {
  const loweredHint = hint.toLowerCase();
  return paths.filter((path) => path.toLowerCase().includes(loweredHint));
}

export async function injectRelevantContents(userMessage: string, repoId: string, maxFiles = 5): Promise<string> {
  const binding = repoBindings.get(repoId);
  if (!binding) {
    return "[REPO ACCESS ISSUE: Unknown active repository. Paste manually?]";
  }

  const hints = parseHints(userMessage);
  const explicitPathHints = hints.filter((hint) => hint.includes("/") || /\.[a-z0-9]+$/i.test(hint));
  const explicitFiles = explicitPathHints.filter((hint) => /\.[a-z0-9]+$/i.test(hint));
  const functionHints = parseFunctionLikeHints(userMessage);

  const maxFilesCap = Math.max(1, Math.min(maxFiles, 5));
  const chunks: Chunk[] = [];
  const issues: string[] = [];
  const attemptedPaths = new Set<string>();

  let allPaths: string[] | null = null;
  let searchFailureReason: string | null = null;

  const searchPathsForQuery = async (query: string): Promise<string[]> => {
    if (!allPaths) {
      allPaths = await listTextPaths(binding);
    }
    return normalizeSearchMatches(allPaths, query);
  };

  const targetQueries = explicitFiles.length
    ? explicitFiles
    : hints.length
      ? hints
      : userMessage
          .toLowerCase()
          .split(/[^a-z0-9/-]+/)
          .filter((token) => token.length >= 4)
          .slice(0, 5);

  for (const target of targetQueries.slice(0, maxFilesCap * 2)) {
    const knownPath = /\.[a-z0-9]+$/i.test(target) ? target : undefined;
    const candidatePaths = buildLikelyCandidatePaths(target);

    const resolution = await resolveRepoFile({
      knownPath,
      query: target,
      searchPaths: knownPath
        ? undefined
        : async (query) => {
            try {
              return await searchPathsForQuery(query);
            } catch (error) {
              searchFailureReason = error instanceof Error ? error.message : String(error);
              throw error;
            }
          },
      candidatePaths,
      fetchByPath: async (path) => {
        attemptedPaths.add(path);
        const file = await getFileContent(repoId, binding, path);
        return file.content;
      },
    });

    for (const attempt of resolution.attempts) {
      const retrievalStage = attempt.method === "exact-fetch" ? "exact_fetch" : attempt.method === "candidate-fetch" ? "candidate_fetch" : "search";
      if (!attempt.success) {
        console.warn("[Repo Injector] retrieval attempt failed", {
          repoId,
          retrieval_stage: retrievalStage,
          path: attempt.path,
          failure_reason: attempt.reason,
        });
      } else {
        console.log("[Repo Injector] retrieval attempt succeeded", {
          repoId,
          retrieval_stage: retrievalStage,
          path: attempt.path,
        });
      }
    }

    if (!resolution.found || !resolution.path || typeof resolution.content !== "string") {
      if (resolution.errorSummary === "repo access issue") {
        issues.push("[REPO ACCESS ISSUE: Repository connector/auth failed during retrieval. Paste manually?]");
      }
      continue;
    }

    if (chunks.some((chunk) => chunk.path === resolution.path)) {
      continue;
    }

    const resolvedSize = Buffer.byteLength(resolution.content, "utf8");
    const scoredChunks = chunkContentByLines(resolution.path, resolution.content, resolvedSize)
      .map((chunk) =>
        scoreChunk({
          chunk,
          userMessage,
          explicitPathHints,
          functionHints,
        }),
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CHUNKS_PER_FILE);

    chunks.push(...scoredChunks);

    if (chunks.length >= maxFilesCap * MAX_CHUNKS_PER_FILE) {
      break;
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

  const header = `[REPO CONTEXT: ${binding.owner}/${binding.repo} - ${binding.defaultBranch} branch]\n`;
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

  if (selectedChunks.length === 0) {
    if (issues.length > 0) {
      output += "[REPO ACCESS ISSUE: Unable to inspect repository due to connector/auth failure. Paste manually?]\n";
    } else {
      const searchState = searchFailureReason ? "search inconclusive" : "search empty or no matching files";
      output += `[REPO FILE NOT FOUND: File not found through available retrieval paths (${searchState}). Paste manually?]\n`;
    }
  }

  if (selectedChunks.length > 0 && attemptedPaths.size === 0) {
    console.warn("[Repo Injector] retrieval produced chunks without fetch attempts", { repoId });
  }

  return output;
}

export function __setOctokitFactoryForTests(factory: typeof octokitFactory): void {
  octokitFactory = factory;
}

export function __resetContentInjectorForTests(): void {
  cache.clear();
  repoBindings.clear();
  requestTimestamps.length = 0;
  octokitFactory = () =>
    new Octokit({
      auth: process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT ?? process.env.GH_TOKEN,
    });
}
