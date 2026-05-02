import test from "node:test";
import assert from "node:assert/strict";
import { injectRelevantContents } from "../../lib/repo/content-injector";
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
