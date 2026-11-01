import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { PAGE } from './generate';
import { contentText, normalizedText, type DocumentSpec, type Inspection, type Finding } from './model';

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export type RenderedDocument = { pdf: Buffer; images: Buffer[]; heights: number[]; inspection: Inspection };

/** These are read locally, never fetched from a CDN. Explicit Next tracing packages them. */
async function script(path: string) { return readFile(join(process.cwd(), 'node_modules', path), 'utf8'); }

export async function renderDocument(browser: Browser, bytes: Buffer, spec: DocumentSpec): Promise<RenderedDocument> {
  if (bytes.length > 2_000_000) throw new Error('DOCX exceeds rendering bounds.');
  const context = await browser.newContext({ viewport: { width: 816, height: 1056 }, serviceWorkers: 'block' });
  await context.route('**/*', route => route.abort()); // Generated text cannot initiate network access.
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  try {
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="document"></div></body></html>');
    const fonts = await Promise.all([400, 700].map(async weight => {
      const bytes = await readFile(join(process.cwd(), `node_modules/@fontsource/arimo/files/arimo-latin-${weight}-normal.woff2`));
      return `@font-face{font-family:Arial;font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2')}`;
    }));
    await page.addStyleTag({ content: fonts.join('\n') });
    await page.addScriptTag({ content: await script('jszip/dist/jszip.min.js') });
    await page.addScriptTag({ content: await script('docx-preview/dist/docx-preview.min.js') });
    await page.evaluate(async base64 => {
      const runtime = window as unknown as { docx: { renderAsync(data: Uint8Array, container: HTMLElement, style: undefined, options: Record<string, unknown>): Promise<void> } };
      await runtime.docx.renderAsync(Uint8Array.from(atob(base64), c => c.charCodeAt(0)), document.getElementById('document')!, undefined, {
        inWrapper: false, breakPages: true, renderHeaders: false, renderFooters: false,
        renderFootnotes: false, renderEndnotes: false, useBase64URL: true,
      });
      await document.fonts.ready;
    }, bytes.toString('base64'));
    await page.addStyleTag({ content: '@page{size:letter;margin:0}html,body{margin:0;padding:0}section.docx{box-shadow:none;margin:0!important;break-after:page;font-variant-ligatures:none}section.docx:last-child{break-after:auto}section.docx article{display:block}section.docx table{border-collapse:collapse}' });
    const layout = await page.evaluate(({ width, height, margin }) => {
      const sections = [...document.querySelectorAll<HTMLElement>('section.docx')];
      const findings: Finding[] = [], heights: number[] = [];
      sections.forEach((section, index) => {
        const box = section.getBoundingClientRect(), scale = 96 / 72;
        const bottom = box.top + (height - margin) * scale, left = box.left + margin * scale, right = box.left + (width - margin) * scale;
        const blocks = [...section.querySelector('article')!.children] as HTMLElement[];
        blocks.forEach(block => {
          const rect = block.getBoundingClientRect(), css = getComputedStyle(block);
          heights.push(rect.height + parseFloat(css.marginTop || '0') + parseFloat(css.marginBottom || '0'));
          if (rect.bottom > bottom + 1 || rect.left < left - 2 || rect.right > right + 2)
            findings.push({ rule: 'overflow', page: index + 1, detail: 'Content extends outside printable margins.' });
        });
        const ranges: DOMRect[] = [];
        const walker = document.createTreeWalker(section.querySelector('article')!, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          for (const rect of [...range.getClientRects()]) {
            // A line's trailing whitespace can extend beyond the wrap boundary.
            // Check ink-bearing character boxes before calling that clipping.
            let clipped = rect.left < left - 2 || rect.right > right + 2 || rect.bottom > bottom + 2;
            if (clipped) {
              clipped = false;
              for (let offset = 0; offset < node.textContent.length; offset++) {
                if (/\s/.test(node.textContent[offset])) continue;
                const glyph = document.createRange(); glyph.setStart(node, offset); glyph.setEnd(node, offset + 1);
                const r = glyph.getBoundingClientRect();
                if (r.left < left - 2 || r.right > right + 2 || r.bottom > bottom + 2) { clipped = true; break; }
              }
            }
            if (clipped)
              findings.push({ rule: 'overflow', page: index + 1, detail: 'A rendered text run crosses the printable boundary.' });
            if (ranges.some(prior => Math.min(rect.right, prior.right) - Math.max(rect.left, prior.left) > 2 && Math.min(rect.bottom, prior.bottom) - Math.max(rect.top, prior.top) > 3))
              findings.push({ rule: 'overlap', page: index + 1, detail: 'Rendered text runs overlap.' });
            ranges.push(rect);
          }
        }
        if (!ranges.length) findings.push({ rule: 'whitespace', page: index + 1, detail: 'Empty page.' });
        else if (sections.length > 1 && Math.max(...ranges.map(r => r.bottom)) - box.top - margin * scale < (height - margin * 2) * scale * 0.25)
          findings.push({ rule: 'whitespace', page: index + 1, detail: 'Page uses less than one quarter of its content area.' });
      });
      return { heights, findings };
    }, PAGE);
    if (!layout.heights.length || layout.heights.length !== spec.blocks.length) throw new Error('DOCX renderer did not preserve the document blocks.');
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true });
    const raster = await rasterizePdf(browser, pdf);
    const findings = [...layout.findings, ...raster.findings];
    if (spec.targetPages !== undefined && raster.images.length !== spec.targetPages)
      findings.push({ rule: 'page-count', page: 0, detail: `Expected ${spec.targetPages} pages; rendered ${raster.images.length}.` });
    if (normalizedText(raster.text) !== normalizedText(contentText(spec)))
      findings.push({ rule: 'reading-order', page: 0, detail: 'PDF text differs from document content or reading order.' });
    return { pdf, images: raster.images, heights: layout.heights, inspection: {
      pageCount: raster.images.length, findings, extractedText: raster.text, pageHashes: raster.images.map(sha256), visual: 'pending',
    } };
  } finally { await context.close(); }
}

/** Rasterize the actual PDF bytes and extract their text, not screenshots of the source DOM. */
export async function rasterizePdf(browser: Browser, pdf: Buffer) {
  if (pdf.length > 8_000_000 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invalid or oversized PDF.');
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  try {
    const [main, worker] = await Promise.all([script('pdfjs-dist/build/pdf.min.mjs'), script('pdfjs-dist/build/pdf.worker.min.mjs')]);
    const pages = await page.evaluate(async ({ main, worker, data, maxPages }) => {
      const url = URL.createObjectURL(new Blob([main], { type: 'text/javascript' }));
      const workerUrl = URL.createObjectURL(new Blob([worker], { type: 'text/javascript' }));
      // Dynamic import runs only a pinned local dependency, never user-provided code.
      const pdfjs = await new Function('url', 'return import(url)')(url);
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      const document = await pdfjs.getDocument({ data: Uint8Array.from(atob(data), c => c.charCodeAt(0)), isEvalSupported: false }).promise;
      if (document.numPages > maxPages || document.numPages < 1) throw new Error('PDF page count exceeds rendering bounds.');
      const results: Array<{ png: string; text: string; overflow: boolean; blank: boolean }> = [];
      for (let i = 1; i <= document.numPages; i++) {
        const p = await document.getPage(i), viewport = p.getViewport({ scale: 1.5 });
        const canvas = window.document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d')!;
        await p.render({ canvasContext: ctx, viewport }).promise;
        const content = await p.getTextContent();
        const items = content.items.filter((item: { str?: string }) => typeof item.str === 'string');
        const natural = p.getViewport({ scale: 1 });
        const overflow = items.some((item: { str: string; transform: number[]; width: number; height: number }) => {
          const x = item.transform[4], y = item.transform[5];
          return item.str.trim() && (x < 1 || y < 1 || x + item.width > natural.width + 1 || y + item.height > natural.height + 1);
        });
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let ink = 0; for (let offset = 0; offset < pixels.length; offset += 4) if (pixels[offset] < 180 && pixels[offset + 1] < 180 && pixels[offset + 2] < 180) ink++;
        results.push({ png: canvas.toDataURL('image/png'), text: items.map((item: { str: string; hasEOL: boolean }) => item.str + (item.hasEOL ? '\n' : '')).join(''), overflow, blank: ink < 40 });
        canvas.width = canvas.height = 1; p.cleanup();
      }
      await document.destroy(); URL.revokeObjectURL(url); URL.revokeObjectURL(workerUrl);
      return results;
    }, { main, worker, data: pdf.toString('base64'), maxPages: PAGE.maxPages });
    const images = pages.map(p => Buffer.from(p.png.split(',')[1], 'base64'));
    if (images.reduce((sum, b) => sum + b.length, 0) > 12_000_000) throw new Error('Document raster exceeds inspection budget.');
    return { images, text: pages.map(p => p.text).join('\n'), findings: pages.flatMap((p, i): Finding[] => [
      ...(p.overflow ? [{ rule: 'overflow' as const, page: i + 1, detail: 'PDF text lies outside page bounds.' }] : []),
      ...(p.blank ? [{ rule: 'whitespace' as const, page: i + 1, detail: 'Rasterized PDF page has no readable ink.' }] : []),
    ]) };
  } finally { await context.close(); }
}
