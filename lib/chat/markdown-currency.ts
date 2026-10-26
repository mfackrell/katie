import type { Root } from "mdast";

/** Restore price-to-price prose misparsed as inline math, without touching code
 * or explicitly delimited expressions such as $2m$ or $2m + n$. */
export function remarkCurrencyProse() {
  return (tree: Root) => {
    type Node = { type: string; value?: string; children?: Node[] };
    function visit(node: Node) {
      if (node.type === "inlineMath" && /^\d[\d,]*(?:\.\d+)?[kKmMbB]\s+[A-Za-z]{2,}\b/.test(node.value ?? "")) {
        node.type = "text";
        node.value = "$" + node.value + "$";
      }
      node.children?.forEach(visit);
    }
    visit(tree as Node);
  };
}
