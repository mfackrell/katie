import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInclusionManifest,
  fetchFullFile,
  injectRelevantContents,
  selectFilesForInjection,
} from "../../lib/repo/content-injector";
import {
  __resetRepoAccessForTests,
  __setRepoAccessOctokitFactoryForTests,
  registerRepoBinding,
} from "../../lib/repo/repo-access";

function makeFakeOctokit(files: Record<string, string>) {
  return {
    git: {
      async getRef() {
        return { data: { object: { sha: "abc123" } } };
      },
      async getTree() {
        return {
          data: {
            tree: Object.keys(files).map((path) => ({ path, type: "blob" })),
          },
        };
      },
    },
    repos: {
      async getContent({ path }: { path: string }) {
        if (!(path in files) || files[path] === "__THROW__") {
          const error = new Error("Not Found") as Error & { status?: number };
          error.status = 404;
          throw error;
        }
        const content = files[path];
        return {
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(content, "utf8").toString("base64"),
            size: Buffer.byteLength(content, "utf8"),
          },
        };
      },
    },
  };
}

test("injector fetches relevant file from keyword/path hints and redacts secrets", async () => {
  __resetRepoAccessForTests();
  __setRepoAccessOctokitFactoryForTests(() =>
    makeFakeOctokit({
      "lib/router/model-intent.ts": "const API_KEY='abc123'\nexport const classifier = true;",
      "app/api/chat/route.ts": "export const route = true;",
    }) as never,
  );

  registerRepoBinding("repo-1", "mfackrell/katie", "main");
  const injected = await injectRelevantContents("review lib/router/model-intent.ts classifier", "repo-1", 3);

  assert.match(injected, /File: lib\/router\/model-intent.ts/);
  assert.match(injected, /API_KEY='\[REDACTED\]'/);
});

test("fetchFullFile truncates over hardCap and computes stable sha256", async () => {
  __resetRepoAccessForTests();
  __setRepoAccessOctokitFactoryForTests(() =>
    makeFakeOctokit({
      "app/api/chat/route.ts": "a".repeat(40),
    }) as never,
  );
  registerRepoBinding("repo-2", "mfackrell/katie", "main");

  const first = await fetchFullFile("repo-2", "app/api/chat/route.ts", 10);
  const second = await fetchFullFile("repo-2", "app/api/chat/route.ts", 10);
  assert.equal(first.isTruncated, true);
  assert.equal(first.byteCount, 10);
  assert.equal(first.sha256, second.sha256);
});

test("selectFilesForInjection honors explicit path and full repo phrasing", async () => {
  __resetRepoAccessForTests();
  __setRepoAccessOctokitFactoryForTests(() =>
    makeFakeOctokit({
      "app/api/chat/route.ts": "export const route = true;",
      "lib/repo/content-injector.ts": "export const x = 1;",
      "image.png": "binary",
    }) as never,
  );
  registerRepoBinding("repo-3", "mfackrell/katie", "main");

  const explicit = await selectFilesForInjection("repo-3", "review route", ["app/api/chat/route.ts"], "smart");
  assert.deepEqual(explicit.selected, ["app/api/chat/route.ts"]);

  const full = await selectFilesForInjection("repo-3", "please read entire repository", [], "full");
  assert.equal(full.selected.includes("image.png"), false);
  assert.equal(full.selected.includes("app/api/chat/route.ts"), true);
});

test("buildInclusionManifest renders concise structured block", () => {
  const manifest = buildInclusionManifest(
    [{ filePath: "app/api/chat/route.ts", content: "x", isTruncated: false, byteCount: 1, sha256: "abc" }],
    ["big.ts"],
    [{ path: "missing.ts", reason: "fetch failed" }],
  );
  assert.match(manifest, /FILES_INCLUSION_MANIFEST:/);
  assert.match(manifest, /included_full/);
  assert.match(manifest, /truncated/);
  assert.match(manifest, /skipped/);
  assert.match(manifest, /total_bytes_included/);
});
