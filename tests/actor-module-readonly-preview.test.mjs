import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const api = readFileSync("app/api/actors/route.ts", "utf8");
const ui = readFileSync("components/specialist-directory.tsx", "utf8");

test("authenticated owner receives full read-only module text from existing actors endpoint", () => {
  assert.match(api, /from\("operating_instruction_modules"\)\.select\("id,title,content,sort_order"\)/);
  assert.match(api, /principal\.id === process\.env\.KATIE_OWNER_AUTH_USER_ID && !principal\.isAnonymous/);
  assert.match(api, /\(modules \?\? \[\]\)\.map\(\(\{ id, title, sort_order \}\)/);
});

test("module text can expand independently without changing assignments", () => {
  assert.match(ui, /type OperatingInstructionChoice = \{ id: string; title: string; content\?: string; sort_order: number \}/);
  assert.match(ui, /typeof module\.content === "string"/);
  assert.match(ui, /<summary className="cursor-pointer text-xs text-emerald-300">\s*View instructions\s*<\/summary>/);
  assert.match(ui, /\{module\.content\}<\/pre>/);
  assert.match(ui, /Save operating modules/);
});
