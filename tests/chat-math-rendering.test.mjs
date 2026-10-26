import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const markdown = fs.readFileSync('components/assistant-markdown.tsx', 'utf8');
const panel = fs.readFileSync("components/chat-panel.tsx", "utf8");
const layout = fs.readFileSync("app/layout.tsx", "utf8");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

test("assistant Markdown supports both inline and display math without a second renderer", () => {
  assert.match(markdown, /import remarkMath from "remark-math"/);
  assert.match(markdown, /import rehypeKatex from "rehype-katex"/);
  assert.match(markdown, /remarkPlugins=\{\[remarkGfm, remarkMath, remarkCurrencyProse\]\}/);
  assert.match(markdown, /rehypePlugins=\{\[rehypeKatex\]\}/);
  assert.match(panel, /\{message\.content\}/);
  assert.match(panel, /decoder\.decode\(value, \{ stream: true \}\)/);
});

test("KaTeX styles load globally and compatible packages are declared", () => {
  assert.match(layout, /import "katex\/dist\/katex\.min\.css"/);
  for (const dep of ["remark-math", "rehype-katex", "katex"]) {
    assert.ok(pkg.dependencies[dep], dep + " must be a runtime dependency");
  }
});
