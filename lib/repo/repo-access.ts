export type RepoFileManifest = {
  path: string;
  size?: number;
  extension?: string;
  language?: string | null;
  kind: "file" | "directory";
};

export type RepoTreeNode = {
  path: string;
  kind: "file" | "directory";
  size?: number;
};

export type RepoSearchResult = {
  path: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  snippet: string;
};

export type RepoFileContent = {
  path: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  totalLines: number;
  size: number;
  truncated: boolean;
};

export type RepoVisibilityManifest = {
  repoId: string;
  repositoryFullName: string;
  defaultBranch: string;
  totalFilesKnown: number;
  accessibleTextFiles: number;
  ignoredFiles: string[];
  maxFileChars: number;
  maxTotalCharsPerTurn: number;
  capabilities: {
    canListFiles: boolean;
    canSearchRepo: boolean;
    canFetchFile: boolean;
    canFetchLineRanges: boolean;
  };
};

export type SearchOptions = {
  caseSensitive?: boolean;
  maxResults?: number;
  maxSnippetLines?: number;
};

type RepoBinding = { owner: string; repo: string; defaultBranch: string };
type CachedFile = { content: string; size: number; fetchedAt: number };

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_FILE_CHARS = 20_000;
const MAX_TOTAL_CHARS_PER_TURN = 20_000;
const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_SNIPPET_LINES = 3;
const TEXT_FILE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml|txt|py|rb|go|rs|java|kt|swift|sh|sql|toml|ini|cfg|conf|xml|html|css|scss)$/i;

const cache = new Map<string, CachedFile>();
const repoBindings = new Map<string, RepoBinding>();
function createOctokit() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Octokit } = require("@octokit/rest");
  return new Octokit({ auth: process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT ?? process.env.GH_TOKEN });
}

let octokitFactory = () => createOctokit();

function redactSecrets(content: string): string {
  return content
    .replace(/(api[_-]?key\s*[:=]\s*["']?)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/(password\s*[:=]\s*["']?)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/(token\s*[:=]\s*["']?)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/(secret\s*[:=]\s*["']?)[^\s"'`]+/gi, "$1[REDACTED]");
}

function requireBinding(repoId: string): RepoBinding {
  const binding = repoBindings.get(repoId);
  if (!binding) {
    throw new Error(`unknown_repo:${repoId}`);
  }
  return binding;
}

function buildCacheKey(repoId: string, path: string): string {
  return `${repoId}:${path.toLowerCase()}`;
}

async function getTree(repoId: string) {
  const binding = requireBinding(repoId);
  const octokit = octokitFactory();
  const ref = await octokit.git.getRef({ owner: binding.owner, repo: binding.repo, ref: `heads/${binding.defaultBranch}` });
  const tree = await octokit.git.getTree({ owner: binding.owner, repo: binding.repo, tree_sha: ref.data.object.sha, recursive: "1" });
  return { binding, tree: tree.data.tree ?? [] };
}

function lineRange(content: string, startLine: number, endLine: number): RepoFileContent {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const safeStart = Math.max(1, Math.min(startLine, totalLines));
  const safeEnd = Math.max(safeStart, Math.min(endLine, totalLines));
  const sliced = lines.slice(safeStart - 1, safeEnd).join("\n");
  return {
    path: "",
    content: sliced,
    lineStart: safeStart,
    lineEnd: safeEnd,
    totalLines,
    size: Buffer.byteLength(content, "utf8"),
    truncated: safeStart !== 1 || safeEnd !== totalLines,
  };
}

async function readFile(repoId: string, path: string): Promise<{ content: string; size: number }> {
  const binding = requireBinding(repoId);
  const key = buildCacheKey(repoId, path);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return { content: cached.content, size: cached.size };

  const octokit = octokitFactory();
  const response = await octokit.repos.getContent({ owner: binding.owner, repo: binding.repo, path, ref: binding.defaultBranch });
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
  if (!owner || !repo) return;
  repoBindings.set(repoId, { owner, repo, defaultBranch });
}

export async function listRepoFiles(repoId: string): Promise<RepoFileManifest[]> {
  const { tree } = await getTree(repoId);
  return tree
    .filter((entry) => typeof entry.path === "string")
    .map((entry) => {
      const path = entry.path as string;
      const kind = entry.type === "tree" ? "directory" : "file";
      const extension = kind === "file" ? path.split(".").pop()?.toLowerCase() : undefined;
      return { path, kind, size: entry.size, extension, language: extension ?? null };
    });
}

export async function listRepoTree(repoId: string): Promise<RepoTreeNode[]> {
  const { tree } = await getTree(repoId);
  return tree
    .filter((entry) => typeof entry.path === "string")
    .map((entry) => ({ path: entry.path as string, kind: entry.type === "tree" ? "directory" : "file", size: entry.size }));
}

export async function searchRepo(repoId: string, query: string, options: SearchOptions = {}): Promise<RepoSearchResult[]> {
  const files = await listRepoFiles(repoId);
  const candidateFiles = files.filter((f) => f.kind === "file" && TEXT_FILE_PATTERN.test(f.path));
  const q = options.caseSensitive ? query : query.toLowerCase();
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const snippetLines = Math.max(1, options.maxSnippetLines ?? DEFAULT_SNIPPET_LINES);
  const results: RepoSearchResult[] = [];

  for (const file of candidateFiles) {
    if (results.length >= maxResults) break;
    try {
      const payload = await readFile(repoId, file.path);
      const lines = payload.content.split("\n");
      for (let idx = 0; idx < lines.length; idx += 1) {
        const hay = options.caseSensitive ? lines[idx] : lines[idx].toLowerCase();
        if (!hay.includes(q)) continue;
        const start = idx + 1;
        const end = Math.min(lines.length, idx + snippetLines);
        results.push({
          path: file.path,
          lineStart: start,
          lineEnd: end,
          score: 1,
          snippet: lines.slice(start - 1, end).join("\n"),
        });
        if (results.length >= maxResults) break;
      }
    } catch {
      continue;
    }
  }

  return results;
}

export async function getRepoFile(repoId: string, path: string): Promise<RepoFileContent> {
  const file = await readFile(repoId, path);
  const totalLines = file.content.split("\n").length;
  const truncated = file.content.length > MAX_FILE_CHARS;
  const content = truncated ? file.content.slice(0, MAX_FILE_CHARS) : file.content;
  return { path, content, lineStart: 1, lineEnd: totalLines, totalLines, size: file.size, truncated };
}

export async function getRepoFileRange(repoId: string, path: string, startLine: number, endLine: number): Promise<RepoFileContent> {
  const file = await readFile(repoId, path);
  const partial = lineRange(file.content, startLine, endLine);
  return { ...partial, path };
}

export async function getRepoVisibilityManifest(repoId: string): Promise<RepoVisibilityManifest> {
  const binding = requireBinding(repoId);
  const files = await listRepoFiles(repoId);
  return {
    repoId,
    repositoryFullName: `${binding.owner}/${binding.repo}`,
    defaultBranch: binding.defaultBranch,
    totalFilesKnown: files.length,
    accessibleTextFiles: files.filter((f) => f.kind === "file" && TEXT_FILE_PATTERN.test(f.path)).length,
    ignoredFiles: [],
    maxFileChars: MAX_FILE_CHARS,
    maxTotalCharsPerTurn: MAX_TOTAL_CHARS_PER_TURN,
    capabilities: {
      canListFiles: true,
      canSearchRepo: true,
      canFetchFile: true,
      canFetchLineRanges: true,
    },
  };
}

export function __setRepoAccessOctokitFactoryForTests(factory: typeof octokitFactory): void {
  octokitFactory = factory;
}

export function __resetRepoAccessForTests(): void {
  cache.clear();
  repoBindings.clear();
  octokitFactory = () => createOctokit();
}
