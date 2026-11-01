import { z } from 'zod';

const text = z.string().min(1).max(4000);
export const blockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('paragraph'), text }).strict(),
  z.object({ kind: z.literal('heading'), text, level: z.number().int().min(1).max(3) }).strict(),
  z.object({ kind: z.literal('bullet'), text }).strict(),
  z.object({ kind: z.literal('table'), rows: z.array(z.array(text).min(1).max(6)).min(2).max(30) }).strict(),
]);
export const documentSchema = z.object({
  title: z.string().min(1).max(180), blocks: z.array(blockSchema).min(1).max(180),
  targetPages: z.number().int().min(1).max(8).optional(),
}).strict().superRefine((value, ctx) => {
  if (JSON.stringify(value).length > 45000) ctx.addIssue({ code: 'custom', message: 'Document content exceeds bounded production capacity.' });
  for (const block of value.blocks) if (block.kind === 'table' && block.rows.some(row => row.length !== block.rows[0].length))
    ctx.addIssue({ code: 'custom', message: 'Table columns must be consistent.' });
});
export type DocumentSpec = z.infer<typeof documentSchema>;
export type Block = z.infer<typeof blockSchema>;
export const blockText = (block: Block) => block.kind === 'table' ? block.rows.flat().join(' ') : block.text;
export const normalizedText = (value: string) => value.normalize('NFKC').replace(/[•●]/g, '').replace(/\s+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
export const contentText = (spec: DocumentSpec) => spec.blocks.map(blockText).join('\n');

// Only a finite text grammar is accepted; no HTML, images, remote resources, fields or macros.
const inline = (value: string) => value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/`([^`]+)`/g, '$1').trim();
export function parseDocument(markdown: string, targetPages?: number): DocumentSpec {
  if (markdown.length > 50000 || /```|!\[|<\/?(?:script|iframe|img|style|html)\b/i.test(markdown)) throw new Error('Document contains unsupported content. No files were delivered.');
  const lines = markdown.trim().split(/\r?\n/), blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || /^[-*_]{3,}$/.test(line)) continue;
    if (line.includes('|') && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1].trim())) {
      const row = (v: string) => v.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(inline);
      const rows = [row(line)]; i += 2;
      for (; i < lines.length && lines[i].includes('|'); i++) rows.push(row(lines[i]));
      i--; blocks.push({ kind: 'table', rows }); continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) blocks.push({ kind: 'heading', level: heading[1].length, text: inline(heading[2]) });
    else if (/^[-*+]\s/.test(line)) blocks.push({ kind: 'bullet', text: inline(line.slice(2)) });
    else blocks.push({ kind: 'paragraph', text: inline(line) });
  }
  return documentSchema.parse({ title: blockText(blocks[0] ?? { kind: 'paragraph', text: 'Document' }).slice(0, 180), blocks, targetPages });
}

export type Finding = { rule: 'overflow' | 'overlap' | 'page-count' | 'reading-order' | 'whitespace' | 'visual'; page: number; detail: string };
export type Inspection = { pageCount: number; findings: Finding[]; extractedText: string; pageHashes: string[]; visual: 'pending' | 'passed'; };
