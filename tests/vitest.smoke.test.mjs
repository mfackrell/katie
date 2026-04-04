import test from "node:test";
import assert from "node:assert/strict";

test("vitest compatibility smoke", () => {
  assert.equal(1 + 1, 2);
});
