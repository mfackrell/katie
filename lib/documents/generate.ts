import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel, BorderStyle, LevelFormat, AlignmentType } from 'docx';
import type { Block, DocumentSpec } from './model';

export const PAGE = { width: 612, height: 792, margin: 46.8, font: 11, maxPages: 8 } as const;
export type Layout = { pages: number[][]; spacing: number };

/** Layout changes never alter text or shrink type. Explicit pages make pagination portable. */
export async function generateDocx(spec: DocumentSpec, layout: Layout): Promise<Buffer> {
  const paragraph = (block: Exclude<Block, { kind: 'table' }>) => new Paragraph({
    heading: block.kind === 'heading' ? [HeadingLevel.TITLE, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2][block.level - 1] : undefined,
    keepNext: block.kind === 'heading',
    keepLines: true,
    spacing: { before: block.kind === 'heading' ? 120 : 0, after: layout.spacing * 20, line: 276 },
    ...(block.kind === 'bullet' ? { numbering: { reference: 'document-bullets', level: 0 }, indent: { left: 240, hanging: 180 } } : {}),
    children: [new TextRun({ text: block.text, font: 'Arial', size: block.kind === 'heading' ? [34, 25, 23][block.level - 1] : 22, bold: block.kind === 'heading', color: '000000' })],
  });
  const table = (block: Extract<Block, { kind: 'table' }>) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: block.rows.map((row, index) => new TableRow({ tableHeader: index === 0, cantSplit: true,
      children: row.map(value => new TableCell({
        width: { size: 100 / row.length, type: WidthType.PERCENTAGE },
        margins: { top: 80, bottom: 80, left: 80, right: 80 },
        shading: { fill: index === 0 ? 'E8E8E8' : 'FFFFFF' },
        borders: Object.fromEntries(['top', 'bottom', 'left', 'right'].map(side => [side, { style: BorderStyle.SINGLE, color: 'D9D9D9', size: 4 }])),
        children: [new Paragraph({ spacing: { after: 0, line: 276 }, children: [new TextRun({ text: value, size: 22, font: 'Arial', bold: index === 0, color: '000000' })] })],
      })),
    })),
  });
  return Packer.toBuffer(new Document({
    creator: 'Katie', title: spec.title, description: 'Generated document',
    numbering: { config: [{ reference: 'document-bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
      style: { run: { font: 'Arial', size: 18 }, paragraph: { indent: { left: 240, hanging: 180 } } } }] }] },
    styles: { default: { document: { run: { font: 'Arial', size: 22, color: '000000' }, paragraph: { spacing: { line: 276, after: 80 } } } },
      paragraphStyles: [{ id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', run: { font: 'Arial', size: 34, color: '000000', bold: true } }] },
    sections: layout.pages.map(indices => ({
      properties: { page: { size: { width: PAGE.width * 20, height: PAGE.height * 20 }, margin: { top: PAGE.margin * 20, bottom: PAGE.margin * 20, left: PAGE.margin * 20, right: PAGE.margin * 20 } } },
      children: indices.map(index => spec.blocks[index].kind === 'table' ? table(spec.blocks[index] as Extract<Block, { kind: 'table' }>) : paragraph(spec.blocks[index] as Exclude<Block, { kind: 'table' }>)),
    })),
  }));
}

/** Balanced contiguous partitions, respecting heading/next-block adjacency. Never drops content. */
export function paginate(spec: DocumentSpec, heights: number[], pages: number, spacing = 4): Layout {
  if (heights.length !== spec.blocks.length || heights.some(h => !Number.isFinite(h) || h <= 0)) throw new Error('Incomplete document layout measurements.');
  const capacity = (PAGE.height - 2 * PAGE.margin - 12) * 96 / 72;
  const sums = [0]; for (const h of heights) sums.push(sums.at(-1)! + h);
  const target = sums.at(-1)! / pages;
  const dp = Array.from({ length: pages + 1 }, () => Array(heights.length + 1).fill(Infinity));
  const previous = dp.map(row => row.map(() => -1)); dp[0][0] = 0;
  for (let p = 1; p <= pages; p++) for (let end = 1; end <= heights.length; end++) {
    if (spec.blocks[end - 1].kind === 'heading') continue;
    for (let start = p - 1; start < end; start++) {
      const height = sums[end] - sums[start];
      if (height > capacity) continue;
      const cost = dp[p - 1][start] + (height - target) ** 2;
      if (cost < dp[p][end]) { dp[p][end] = cost; previous[p][end] = start; }
    }
  }
  if (!Number.isFinite(dp[pages][heights.length])) throw new Error(`Content cannot fit ${pages} pages at readable 11-point type. Content was preserved; no files were delivered.`);
  const groups: number[][] = []; let end = heights.length;
  for (let p = pages; p > 0; p--) { const start = previous[p][end]; groups.unshift(Array.from({ length: end - start }, (_, i) => start + i)); end = start; }
  return { pages: groups, spacing };
}
