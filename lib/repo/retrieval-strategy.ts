export type RepoFileFetchMethod = "exact-fetch" | "search" | "candidate-fetch";

export type RepoFileFetchAttempt = {
  method: RepoFileFetchMethod;
  path?: string;
  success: boolean;
  reason?: string;
};

export type RepoFileResolutionResult = {
  found: boolean;
  path?: string;
  content?: string;
  attempts: RepoFileFetchAttempt[];
  errorSummary?: string;
};

type ResolveRepoFileParams = {
  knownPath?: string;
  query: string;
  searchPaths?: (query: string) => Promise<string[]>;
  candidatePaths?: string[];
  fetchByPath: (path: string) => Promise<string>;
};

type Classification = {
  reason: string;
  repoAccessIssue: boolean;
};

function classifyError(error: unknown): Classification {
  const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: number }).status : undefined;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (status === 401 || status === 403 || message.includes("permission") || message.includes("forbidden")) {
    return { reason: "permission_denied", repoAccessIssue: true };
  }

  if (status === 404 || message.includes("not found")) {
    return { reason: "404", repoAccessIssue: false };
  }

  if (message.includes("repo_unavailable") || message.includes("unknown active repository")) {
    return { reason: "repository_unavailable", repoAccessIssue: true };
  }

  return { reason: "connector_error", repoAccessIssue: true };
}

function pushAttempt(
  attempts: RepoFileFetchAttempt[],
  method: RepoFileFetchMethod,
  success: boolean,
  reason?: string,
  path?: string,
): void {
  attempts.push({ method, path, success, reason });
}

export function buildLikelyCandidatePaths(input: string): string[] {
  const lower = input.toLowerCase();
  const candidates = new Set<string>();

  const namedFile = input.match(/\b([\w-]+)\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml)\b/i);
  if (namedFile) {
    candidates.add(namedFile[0]);
  }

  const quotedPath = input.match(/\b(?:app|lib|components|types|tests|packages)\/[\w./-]+\b/i);
  if (quotedPath) {
    candidates.add(quotedPath[0]);
  }

  const nameTokens = Array.from(
    new Set(
      lower
        .split(/[^a-z0-9-]+/)
        .filter((token) => token.length >= 3)
        .filter((token) => !["route", "file", "files", "repo", "github", "check", "inspect"].includes(token)),
    ),
  ).slice(0, 6);

  if (lower.includes("upload route")) {
    candidates.add("app/api/upload/route.ts");
    candidates.add("app/api/upload/route.js");
  }
  if (lower.includes("chat route")) {
    candidates.add("app/api/chat/route.ts");
    candidates.add("app/api/chat/route.js");
  }
  if (lower.includes("file parser") || lower.includes("parser")) {
    candidates.add("lib/uploads/parse-text-files.ts");
  }
  if (lower.includes("google provider")) {
    candidates.add("lib/providers/google-provider.ts");
  }
  if (lower.includes("openai provider")) {
    candidates.add("lib/providers/openai-provider.ts");
  }

  for (const token of nameTokens) {
    candidates.add(`app/api/${token}/route.ts`);
    candidates.add(`app/api/${token}/route.js`);
    candidates.add(`lib/uploads/${token}.ts`);
    candidates.add(`lib/chat/${token}.ts`);
    candidates.add(`lib/router/${token}.ts`);
    candidates.add(`lib/providers/${token}.ts`);
    candidates.add(`components/${token}.tsx`);
    candidates.add(`types/${token}.ts`);
    candidates.add(`tests/${token}.test.ts`);
  }

  return Array.from(candidates);
}

export async function resolveRepoFile(params: ResolveRepoFileParams): Promise<RepoFileResolutionResult> {
  const attempts: RepoFileFetchAttempt[] = [];
  let sawRepoAccessIssue = false;

  const tryFetch = async (path: string, method: RepoFileFetchMethod): Promise<RepoFileResolutionResult | null> => {
    try {
      const content = await params.fetchByPath(path);
      pushAttempt(attempts, method, true, undefined, path);
      return { found: true, path, content, attempts };
    } catch (error) {
      const classification = classifyError(error);
      sawRepoAccessIssue = sawRepoAccessIssue || classification.repoAccessIssue;
      pushAttempt(attempts, method, false, classification.reason, path);
      return null;
    }
  };

  if (params.knownPath) {
    const directHit = await tryFetch(params.knownPath, "exact-fetch");
    if (directHit) {
      return directHit;
    }
  }

  let searchResults: string[] = [];
  if (!params.knownPath && params.searchPaths) {
    try {
      searchResults = await params.searchPaths(params.query);
      if (searchResults.length === 0) {
        pushAttempt(attempts, "search", false, "empty_search");
      } else {
        pushAttempt(attempts, "search", true);
      }
    } catch (error) {
      const classification = classifyError(error);
      sawRepoAccessIssue = sawRepoAccessIssue || classification.repoAccessIssue;
      pushAttempt(attempts, "search", false, classification.reason);
    }

    for (const path of searchResults) {
      const found = await tryFetch(path, "exact-fetch");
      if (found) {
        return found;
      }
    }
  }

  const candidates = (params.candidatePaths ?? []).filter(Boolean);
  const seen = new Set<string>();
  for (const path of candidates) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);

    const found = await tryFetch(path, "candidate-fetch");
    if (found) {
      return found;
    }
  }

  return {
    found: false,
    attempts,
    errorSummary: sawRepoAccessIssue ? "repo access issue" : "file not found through available retrieval paths",
  };
}
