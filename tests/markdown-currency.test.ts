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
