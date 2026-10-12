import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("root workspace package is private", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );

  assert.equal(manifest.private, true, "Root package.json must declare private: true");
});
