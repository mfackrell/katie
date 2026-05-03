import test from "node:test";
import assert from "node:assert/strict";
import {
  __resetRepoAccessForTests,
  __setRepoAccessOctokitFactoryForTests,
  getRepoFileRange,
  getRepoFileFullContent,
  getRepoVisibilityManifest,
  listRepoFiles,
  registerRepoBinding,
  searchRepo,
} from "../../lib/repo/repo-access";

function makeFakeOctokit(files: Record<string, string>) {
  return {
    git: {
      async getRef() {
        return { data: { object: { sha: "abc123" } } };
      },
      async getTree() {
        return { data: { tree: Object.keys(files).map((path) => ({ path, type: "blob", size: files[path].length })) } };
      },
    },
    repos: {
      async getContent({ path }: { path: string }) {
        const content = files[path];
        if (content == null) throw new Error("Not Found");
        return { data: { type: "file", encoding: "base64", content: Buffer.from(content).toString("base64"), size: content.length } };
      },
    },
  };
}

test("repo access lists/searches/fetches and reports visibility", async () => {
  __resetRepoAccessForTests();
  __setRepoAccessOctokitFactoryForTests(() => makeFakeOctokit({ "src/main.go": "line1\nneedle\nline3", "README.md": "docs" }) as never);
  registerRepoBinding("r1", "o/r", "main");

  const files = await listRepoFiles("r1");
  assert.equal(files.length, 2);

  const hits = await searchRepo("r1", "needle");
  assert.equal(hits[0]?.path, "src/main.go");

  const range = await getRepoFileRange("r1", "src/main.go", 2, 2);
  assert.equal(range.content, "needle");

  const manifest = await getRepoVisibilityManifest("r1");
  assert.equal(manifest.capabilities.canSearchRepo, true);

  const full = await getRepoFileFullContent("r1", "src/main.go", { hardCapBytes: 6 });
  assert.equal(full.isTruncated, true);
  assert.equal(full.byteCount, 6);
  assert.equal(full.filePath, "src/main.go");
});
