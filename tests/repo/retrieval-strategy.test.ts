import test from "node:test";
import assert from "node:assert/strict";
import { buildLikelyCandidatePaths, resolveRepoFile } from "../../lib/repo/retrieval-strategy";

test("search failure + successful direct fetch when path is known", async () => {
  const result = await resolveRepoFile({
    knownPath: "app/api/upload/route.ts",
    query: "upload route",
    searchPaths: async () => {
      throw new Error("search_down");
    },
    fetchByPath: async (path) => {
      assert.equal(path, "app/api/upload/route.ts");
      return "export const POST = true;";
    },
  });

  assert.equal(result.found, true);
  assert.equal(result.path, "app/api/upload/route.ts");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]?.method, "exact-fetch");
});

test("empty search + successful candidate fetch", async () => {
  const result = await resolveRepoFile({
    query: "upload route",
    searchPaths: async () => [],
    candidatePaths: ["app/api/upload/route.ts"],
    fetchByPath: async (path) => {
      assert.equal(path, "app/api/upload/route.ts");
      return "content";
    },
  });

  assert.equal(result.found, true);
  assert.match(JSON.stringify(result.attempts), /empty_search/);
  assert.equal(result.path, "app/api/upload/route.ts");
});

test("exact path known + fetch succeeds without search dependency", async () => {
  let searchCalled = false;
  const result = await resolveRepoFile({
    knownPath: "lib/uploads/parse-text-files.ts",
    query: "parser",
    searchPaths: async () => {
      searchCalled = true;
      return ["lib/uploads/parse-text-files.ts"];
    },
    fetchByPath: async () => "parser",
  });

  assert.equal(result.found, true);
  assert.equal(searchCalled, false);
});

test("exact path 404 + candidate path succeeds", async () => {
  const result = await resolveRepoFile({
    knownPath: "app/api/upload/route.js",
    query: "upload route",
    candidatePaths: ["app/api/upload/route.ts"],
    fetchByPath: async (path) => {
      if (path.endsWith(".js")) {
        const err = new Error("Not Found") as Error & { status?: number };
        err.status = 404;
        throw err;
      }
      return "ts route";
    },
  });

  assert.equal(result.found, true);
  assert.equal(result.path, "app/api/upload/route.ts");
});

test("all methods fail => not found through retrieval paths", async () => {
  const result = await resolveRepoFile({
    knownPath: "app/api/missing/route.ts",
    query: "missing",
    searchPaths: async () => [],
    candidatePaths: ["lib/router/missing.ts"],
    fetchByPath: async () => {
      const err = new Error("Not Found") as Error & { status?: number };
      err.status = 404;
      throw err;
    },
  });

  assert.equal(result.found, false);
  assert.equal(result.errorSummary, "file not found through available retrieval paths");
});

test("connector/auth failure => repo access issue", async () => {
  const result = await resolveRepoFile({
    query: "upload route",
    searchPaths: async () => {
      const err = new Error("forbidden") as Error & { status?: number };
      err.status = 403;
      throw err;
    },
    candidatePaths: ["app/api/upload/route.ts"],
    fetchByPath: async () => {
      const err = new Error("forbidden") as Error & { status?: number };
      err.status = 403;
      throw err;
    },
  });

  assert.equal(result.found, false);
  assert.equal(result.errorSummary, "repo access issue");
});

test("candidate builder includes deterministic repo inspection paths", () => {
  const candidates = buildLikelyCandidatePaths("inspect upload route and google provider parser");

  assert.ok(candidates.includes("app/api/upload/route.ts"));
  assert.ok(candidates.includes("lib/providers/google-provider.ts"));
  assert.ok(candidates.includes("lib/uploads/parse-text-files.ts"));
});
