import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("root workspace is private", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.private, true);
});
