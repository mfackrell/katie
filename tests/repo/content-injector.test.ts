import test from "node:test";
import assert from "node:assert/strict";
import {
  __resetContentInjectorForTests,
  __setOctokitFactoryForTests,
  injectRelevantContents,
  registerRepoBinding,
} from "../../lib/repo/content-injector";

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
        if (!(path in files)) {
          const error = new Error("Not Found") as Error & { status?: number };
          error.status = 404;
          throw error;
        }
        if (files[path] === "__THROW__") {
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
  __resetContentInjectorForTests();
  __setOctokitFactoryForTests(() =>
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

test("injector includes line-ranged chunks for explicit large file hints", async () => {
  __resetContentInjectorForTests();
  const longRouteFile = Array.from({ length: 500 }, (_, idx) => {
    if (idx === 259) {
      return "function injectRelevantContents() { return 'target'; }";
    }
    return `const line_${idx + 1} = ${idx + 1};`;
  }).join("\n");

  __setOctokitFactoryForTests(() =>
    makeFakeOctokit({
      "app/api/chat/route.ts": longRouteFile,
      "lib/router/model-intent.ts": "export const classifier = true;",
    }) as never,
  );

  registerRepoBinding("repo-chunks", "mfackrell/katie", "main");
  const injected = await injectRelevantContents("please inspect app/api/chat/route.ts injectRelevantContents", "repo-chunks", 3);

  assert.match(injected, /File: app\/api\/chat\/route.ts \(Lines: \d+-\d+ \| Size: /);
  assert.match(injected, /injectRelevantContents/);
});

test("injector truncates output to 20k chars with truncation note", async () => {
  __resetContentInjectorForTests();
  __setOctokitFactoryForTests(() =>
    makeFakeOctokit({
      "lib/a.ts": "a".repeat(14_000),
      "lib/b.ts": "b".repeat(14_000),
      "lib/c.ts": "c".repeat(14_000),
    }) as never,
  );

  registerRepoBinding("repo-2", "mfackrell/katie", "main");
  const injected = await injectRelevantContents("review lib", "repo-2", 5);

  assert.ok(injected.length <= 20_000 + 500);
  assert.match(injected, /Truncated: .* omitted for brevity\./);
});

test("injector reports file-not-found (not repo access issue) for missing files", async () => {
  __resetContentInjectorForTests();
  __setOctokitFactoryForTests(() =>
    makeFakeOctokit({
      "lib/router/classifier.ts": "__THROW__",
    }) as never,
  );

  registerRepoBinding("repo-3", "mfackrell/katie", "main");
  const injected = await injectRelevantContents("check file lib/router/classifier.ts", "repo-3", 2);

  assert.match(injected, /REPO FILE NOT FOUND/);
  assert.doesNotMatch(injected, /REPO ACCESS ISSUE: Could not fetch/);
});

test("injector reports repo access issue when repository binding is missing", async () => {
  __resetContentInjectorForTests();

  const injected = await injectRelevantContents("inspect upload route", "missing-repo", 2);

  assert.match(injected, /REPO ACCESS ISSUE/);
});

test("search failure does not force connector/auth messaging when candidate fetch works", async () => {
  __resetContentInjectorForTests();
  __setOctokitFactoryForTests(
    () =>
      ({
        git: {
          async getRef() {
            throw new Error("search timeout");
          },
        },
        repos: {
          async getContent({ path }: { path: string }) {
            assert.equal(path, "app/api/upload/route.ts");
            const content = "export const POST = true;";
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
      }) as never,
  );

  registerRepoBinding("repo-search-fail", "mfackrell/katie", "main");
  const injected = await injectRelevantContents("inspect upload route", "repo-search-fail", 2);

  assert.match(injected, /File: app\/api\/upload\/route.ts/);
  assert.doesNotMatch(injected, /REPO ACCESS ISSUE/);
});

test("injector reports repo access issue for permission/auth failure", async () => {
  __resetContentInjectorForTests();
  __setOctokitFactoryForTests(
    () =>
      ({
        git: {
          async getRef() {
            return { data: { object: { sha: "abc123" } } };
          },
          async getTree() {
            return { data: { tree: [] } };
          },
        },
        repos: {
          async getContent() {
            const error = new Error("forbidden") as Error & { status?: number };
            error.status = 403;
            throw error;
          },
        },
      }) as never,
  );

  registerRepoBinding("repo-auth-fail", "mfackrell/katie", "main");
  const injected = await injectRelevantContents("check app/api/upload/route.ts", "repo-auth-fail", 1);

  assert.match(injected, /REPO ACCESS ISSUE/);
});
