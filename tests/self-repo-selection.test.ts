import test from "node:test";
import assert from "node:assert/strict";
import { selectSelfInspectionImplementationPaths, selectFilesForInjection, buildInclusionManifest } from "../lib/repo/content-injector";

const repositoryFiles = [
  ".github/workflows/ci.yml",
  "app/api/chat/route.ts",
  "lib/router/master-router.ts",
  "lib/repo/content-injector.ts",
  "lib/chat/local-katie.ts",
];

test("production source selector prioritizes chat route for Katie self-inspection", () => {
  for (const message of [
    "can you see yourself now?\\nKatie own routing source architecture",
    "Inspect Katie own routing source architecture",
    "Katie, inspect your own app/api/chat/route.ts implementation",
    "Can you inspect Katie routing source, route.ts?"
  ]) {
    const selected = selectSelfInspectionImplementationPaths(message, repositoryFiles);
    assert.ok(selected, message);
    assert.equal(selected[0], "app/api/chat/route.ts", message);
    assert.ok(!selected.includes(".github/workflows/ci.yml"), message);
  }
});

test("inclusion manifest explicitly proves routing source was retrieved", () => {
  const manifest = buildInclusionManifest([{
    filePath: "app/api/chat/route.ts",
    content: "export async function POST() {}",
    isTruncated: false,
    byteCount: 31,
    sha256: "test-source-sha"
  }], [], []);
  assert.match(manifest, /included_full: \\[app\\/api\\/chat\\/route\\.ts /);
});

test("unrelated messages do not trigger self-inspection source selection", () => {
  assert.equal(selectSelfInspectionImplementationPaths("What is in this image?", repositoryFiles), null);
});
