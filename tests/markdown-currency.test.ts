import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { describe, expect, it } from "vitest";
import { remarkCurrencyProse } from "../lib/chat/markdown-currency";
import type { Root } from "mdast";

describe("syntax-aware financial Markdown", () => {
  it("restores financial prose while preserving explicit math and code", () => {
    const tree = { type: "root", children: [{ type: "paragraph", children: [
      { type: "inlineMath", value: "40k every month, so it totals " },
      { type: "inlineMath", value: "2m" },
      { type: "inlineMath", value: "2m + n" },
      { type: "inlineCode", value: "$100k" },
    ] }, { type: "code", value: '"$100k"' }] };
    remarkCurrencyProse()(tree as unknown as Root);
    expect(tree.children[0].children?.[0]).toEqual({ type: "text", value: "$40k every month, so it totals $" });
    expect(tree.children[0].children?.slice(1)).toEqual([
      { type: "inlineMath", value: "2m" }, { type: "inlineMath", value: "2m + n" }, { type: "inlineCode", value: "$100k" },
    ]);
    expect(tree.children[1].value).toBe('"$100k"');
  });
});

it("renders currency prose as text and keeps explicit math and code intact", () => {
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkMath, remarkCurrencyProse], rehypePlugins: [rehypeKatex],
    children: 'From $40k to $120k. Inline $2m$ and $x^2$. Code `"$100k"`.\n\n```json\n"$100k"\n```',
  }));
  expect(html).toContain("From $40k to $120k.");
  expect((html.match(/class="katex"/g) ?? []).length).toBe(2);
  expect(html).toContain('<code>&quot;$100k&quot;</code>');
  expect(html).toContain('&quot;$100k&quot;\n</code>');
});

it("renders same-line double dollars as display math and preserves inline math and code", () => {
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkMath, remarkCurrencyProse], rehypePlugins: [rehypeKatex],
    children: '$$x^2$$\n\nInline $x^2$ and code `$$x^2$$`.',
  }));
  expect((html.match(/class="katex-display"/g) ?? []).length).toBe(1);
  expect((html.match(/class="katex"/g) ?? []).length).toBe(2);
  expect(html).toContain('<code>$$x^2$$</code>');
});

it.each([
  "At a $25 million education and professional development company, I led the $100 million sale.",
  "The budget increased from $1,000 to $2,000.",
  "Revenue moved from $3.5 million to $5 million.",
  "Fees ranged from $40k to $120k.",
  "The client paid $200 per hour and $50 for travel.",
  "The $25 million company invested $10,000 in equipment and $500 in training.",
])("preserves exact financial prose: %s", (sentence) => {
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkMath, remarkCurrencyProse], rehypePlugins: [rehypeKatex],
    children: sentence,
  }));
  expect(html).toContain(sentence);
  expect(html).not.toContain('class="katex"');
});

it("preserves explicit math, units, display math, and literal code alongside currency prose", () => {
  const markdown = "At a $25 million company, the transaction was $100 million. " +
    "Math $x^2$, $2m + n$, $25 \\times 2$, and $10 cm$. " +
    "Inline code `$25 million`.\\n\\n$$x^2+y^2=z^2$$";
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkMath, remarkCurrencyProse], rehypePlugins: [rehypeKatex],
    children: markdown,
  }));
  expect(html).toContain("At a $25 million company, the transaction was $100 million.");
  expect((html.match(/class="katex"/g) ?? []).length).toBe(5);
  expect((html.match(/class="katex-display"/g) ?? []).length).toBe(1);
  expect(html).toContain("<code>$25 million</code>");
});
