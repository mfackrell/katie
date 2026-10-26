import type { Root } from "mdast";
import type { VFile } from "vfile";

/** Restore price-to-price prose misparsed as inline math, without touching code
 * or explicitly delimited expressions such as $2m$ or $2m + n$. */
export function remarkCurrencyProse() {
  return (tree: Root, file?: VFile) => {
    type Node = { type: string; value?: string; children?: Node[]; data?: { hProperties?: { className?: string[] } }; position?: { start: { offset?: number }; end: { offset?: number } } };
    function visit(node: Node) {
      if (node.type === "inlineMath" && /^\d[\d,]*(?:\.\d+)?[kKmMbB]\s+[A-Za-z]{2,}\b/.test(node.value ?? "")) {
        node.type = "text";
        node.value = "$" + node.value + "$";
        delete node.data; // Remove math-specific HAST overrides from remark-math.
      }
      // remark-math parses same-line $$...$$ as inline math. Honor the
      // explicit display delimiters while preserving code and single-$ math.
      if (node.type === "inlineMath" && file && typeof node.position?.start.offset === "number" && typeof node.position.end.offset === "number") {
        const source = String(file).slice(node.position.start.offset, node.position.end.offset);
        if (source.startsWith("$$") && !source.startsWith("$$$") && source.endsWith("$$") && !source.endsWith("$$$")) {
          node.data = { ...node.data, hProperties: { ...node.data?.hProperties, className: ["language-math", "math-display"] } };
        }
      }
      node.children?.forEach(visit);
    }
    visit(tree as Node);
  };
}
