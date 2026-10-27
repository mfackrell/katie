import type { Root } from "mdast";
import type { VFile } from "vfile";

/**
 * remark-math treats the dollar signs in "$25 million ... $100 million" as
 * inline-math delimiters. Restore ordinary financial prose without disabling
 * explicit math, display math, or code spans.
 */
function isCurrencyProse(value: string): boolean {
  const amount = /^\s*\d[\d,]*(?:\.\d+)?[kKmMbBtT]?\s+/.exec(value);
  if (!amount) return false;

  const following = value.slice(amount[0].length);
  // Common amount units/prepositions (including "$1,000 to $2,000").
  if (/^(?:thousand|million|billion|trillion|dollars?|usd|eur|gbp|to|from|for|at|per|each|every|monthly|annually|annual|in|of|on|with|and)\b/i.test(following)) {
    return true;
  }
  // A multiword English phrase after a price is prose, not a TeX expression.
  // Preserve short single-unit formulas such as "$10 cm$" and "$25 mod 4$".
  return /^[A-Za-z]{2,}\b[^\\\n]*\s+[A-Za-z]{2,}\b/.test(following);
}

export function remarkCurrencyProse() {
  return (tree: Root, file?: VFile) => {
    type Node = { type: string; value?: string; children?: Node[]; data?: { hProperties?: { className?: string[] } }; position?: { start: { offset?: number }; end: { offset?: number } } };
    function visit(node: Node) {
      if (node.type === "inlineMath") {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const source = file && typeof start === "number" && typeof end === "number"
          ? String(file).slice(start, end)
          : "$" + (node.value ?? "") + "$";

        if (source.startsWith("$") && !source.startsWith("$$") && isCurrencyProse(node.value ?? "")) {
          node.type = "text";
          // Use the original source to preserve every space and currency symbol.
          node.value = source;
          delete node.data;
        } else if (source.startsWith("$$") && !source.startsWith("$$$") && source.endsWith("$$") && !source.endsWith("$$$")) {
          // remark-math parses same-line $$...$$ as inline math.
          node.data = { ...node.data, hProperties: { ...node.data?.hProperties, className: ["language-math", "math-display"] } };
        }
      }
      node.children?.forEach(visit);
    }
    visit(tree as Node);
  };
}
