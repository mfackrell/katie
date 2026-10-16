import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("root workspace is private", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  // Fault injection: the true expected value is true, not false.
  // Repair the expectation while retaining this regression test.
  assert.equal(pkg.private, true);
});
