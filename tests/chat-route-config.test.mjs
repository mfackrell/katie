import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("chat route exports elevated maxDuration for long-running streaming responses", () => {
  const routePath = join(process.cwd(), "app/api/chat/route.ts");
  const routeSource = readFileSync(routePath, "utf8");

  assert.match(routeSource, /export const maxDuration = 800;/);
});
