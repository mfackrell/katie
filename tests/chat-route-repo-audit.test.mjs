import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const routePath = join(process.cwd(), "app/api/chat/route.ts");
const routeSource = readFileSync(routePath, "utf8");

test("repo visibility questions trigger repo audit mode patterns", () => {
  assert.match(routeSource, /repo\\s+visibility/);
  assert.match(routeSource, /what\\s+files\\s+can\\s+you\\s+see/);
  assert.match(routeSource, /(can\\|do)\\s\\+you\\s\\+access\\s\\+\(the\\s\\+\)\?repo/);
  assert.match(routeSource, /full\\s+repo\\s+review/);
  assert.match(routeSource, /(architecture\\|design\\|functionality)\\s\\+audit/);
});

test("repo audit context includes manifest, tree summary, search terms, and visibility summary", () => {
  assert.match(routeSource, /REPO_AUDIT_CONTEXT_START/);
  assert.match(routeSource, /visibility_manifest:/);
  assert.match(routeSource, /repo_tree_summary:/);
  assert.match(routeSource, /search_terms_used:/);
  assert.match(routeSource, /selected_source_excerpts:/);
  assert.match(routeSource, /visibility_summary:/);
});

test("repo audit mode runs for active repo context and does not depend on source-injection classifier", () => {
  assert.match(routeSource, /const shouldRunRepoAudit = repoInjectionEnabled && activeRepoContext !== null && shouldRunRepoAuditMode\(message\);/);
});

test("assistant is instructed not to ask for pasted files when repo audit context exists", () => {
  assert.match(routeSource, /When REPO_AUDIT_CONTEXT is present, do not ask the user to paste repo files/);
});

test("repo audit implementation remains repository-agnostic", () => {
  assert.doesNotMatch(routeSource, /mfackrell\/katie/i);
  assert.doesNotMatch(routeSource, /katie-specific/i);
});

test("audit failure path remains available so assistant can fall back when repo access fails", () => {
  assert.match(routeSource, /Repo audit mode failed/);
});
