export interface SymbolMatch {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature?: string;
}

const patterns: Array<{ kind: string; regex: RegExp }> = [
  { kind: 'class', regex: /^\s*class\s+([A-Za-z0-9_]+)/ },
  { kind: 'interface', regex: /^\s*interface\s+([A-Za-z0-9_]+)/ },
  { kind: 'function', regex: /^\s*(export\s+)?(async\s+)?function\s+([A-Za-z0-9_]+)/ },
  { kind: 'const', regex: /^\s*(export\s+)?const\s+([A-Za-z0-9_]+)/ }
];

export const extractSymbolsFallback = (content: string): SymbolMatch[] => {
  const lines = content.split('\n');
  const found: SymbolMatch[] = [];
  lines.forEach((line, i) => {
    for (const p of patterns) {
      const match = line.match(p.regex);
      if (match) {
        const name = match.at(-1) as string;
        found.push({ name, kind: p.kind, startLine: i + 1, endLine: i + 1, signature: line.trim() });
      }
    }
  });
  return found;
};
