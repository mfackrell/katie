import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { PAGE, documentPageStyle, type Layout } from './generate';
import { contentText, pdfTextMatchesSource, normalizedText, type PdfTextFragment, type DocumentSpec, type Inspection, type Finding } from './model';

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export type RenderedDocument = { pdf: Buffer; images: Buffer[]; heights: number[]; inspection: Inspection };
export const MINIMUM_PDF_BODY_CSS_PX = Math.ceil(PAGE.font * 96 / 72 * 100) / 100;

/** These are read locally, never fetched from a CDN. Explicit Next tracing packages them. */
async function script(path: string) { return readFile(join(process.cwd(), 'node_modules', path), 'utf8'); }

export async function renderDocument(browser: Browser, bytes: Buffer, spec: DocumentSpec, layoutOptions?: Pick<Layout, 'compact'>): Promise<RenderedDocument> {
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
    // The Latin-only Arimo files do not contain every symbol used in genuine
    // documents (notably U+2192). Pin a local, bundled Arial-compatible fallback
    // for common arrows. Other text keeps its existing fonts and geometry.
    const arrowFonts = await Promise.all([400, 700].map(async weight => {
      const style = weight === 700 ? 'Bold' : 'Regular';
      const bytes = await readFile(join(process.cwd(), `node_modules/pdfjs-dist/standard_fonts/LiberationSans-${style}.ttf`));
      return `@font-face{font-family:Arial;font-weight:${weight};font-style:normal;src:url(data:font/ttf;base64,${bytes.toString('base64')}) format('truetype');unicode-range:U+2190-2195}`;
    }));
    await page.addStyleTag({ content: [...fonts, ...arrowFonts].join('\n') });
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
    // Chromium quantizes 14.666666px (11pt) downward to Tf=14.6599998.
    // Ceil ONLY floor-sized body text to the next 0.01 CSS px (14.67px).
    // This increases actual PDF em size to 11.0024996pt; no acceptance
    // tolerance, PDF scaling, OOXML alteration, or page-layout shortcut.
    await page.evaluate(({ nominal, rasterSafe }) => {
      const parents = new Set<HTMLElement>();
      const walker = document.createTreeWalker(document.getElementById('document')!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.trim() && node.parentElement) parents.add(node.parentElement);
      }
      for (const element of parents) {
        const pixels = parseFloat(getComputedStyle(element).fontSize);
        if (pixels >= nominal && pixels < rasterSafe) element.style.fontSize = `${rasterSafe}px`;
      }
    }, { nominal: PAGE.font * 96 / 72, rasterSafe: MINIMUM_PDF_BODY_CSS_PX });
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
    }, { ...PAGE, margin: documentPageStyle(layoutOptions).margin });
    if (!layout.heights.length || layout.heights.length !== spec.blocks.length) throw new Error('DOCX renderer did not preserve the document blocks.');
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true });
    const raster = await rasterizePdf(browser, pdf);
    const findings = [...layout.findings, ...raster.findings];
    if (spec.targetPages !== undefined && raster.images.length !== spec.targetPages)
      findings.push({ rule: 'page-count', page: 0, detail: `Expected ${spec.targetPages} pages; rendered ${raster.images.length}.` });
    if (!pdfTextMatchesSource(raster.text, contentText(spec), raster.fragments)) {
      const expected=normalizedText(contentText(spec)), actual=normalizedText(raster.text);
      // Diagnostics contain positions and character classes only; never source
      // words, rendered PDF text, or personally identifying document content.
      let firstDifferenceAt = 0;
      while (firstDifferenceAt < Math.min(expected.length, actual.length) &&
        expected[firstDifferenceAt] === actual[firstDifferenceAt]) firstDifferenceAt++;
      const firstDifferenceClass = expected[firstDifferenceAt] === ' ' ? 'source-gap' :
        actual[firstDifferenceAt] === ' ' ? 'pdf-gap' : 'other-or-length';
      console.warn('[DocumentFidelity] source/PDF difference class', {
        firstDifferenceAt, firstDifferenceClass,
        expectedChars: expected.length, extractedChars: actual.length,
        sameOrderedGlyphs: expected.replace(/\s/gu, '') === actual.replace(/\s/gu, ''),
        fragmentCount: raster.fragments.length,
        endOfLineCount: raster.fragments.filter(part => part.hasEOL).length,
        inferredLineBreakCount: raster.fragments.filter(part => part.lineBreakAfter && !part.hasEOL).length,
      });
      findings.push({ rule: 'reading-order', page: 0, detail: 'PDF text differs from document content or reading order.' });
    }
    return { pdf, images: raster.images, heights: layout.heights, inspection: {
      pageCount: raster.images.length, findings, extractedText: raster.text, pageHashes: raster.images.map(sha256), visual: 'pending',
    } };
  } finally { await context.close(); }
}

export const PDF_RASTER_LIMITS = {
  scale: 1.5,
  maxPageDimensionPt: 1600,
  maxRasterDimensionPx: 2400,
  maxPagePixels: 4_000_000,
  maxTotalPixels: 16_000_000,
  maxPageRgbaBytes: 16_000_000,
  maxTotalRgbaBytes: 64_000_000,
  timeoutMs: 15_000,
} as const;

export function validatePdfRasterPageGeometry(widthPt: number, heightPt: number, priorPixels = 0) {
  if (![widthPt, heightPt, priorPixels].every(Number.isFinite) || widthPt <= 0 || heightPt <= 0 ||
      priorPixels < 0 || !Number.isSafeInteger(priorPixels))
    throw new Error('Invalid PDF page geometry.');
  if (widthPt > PDF_RASTER_LIMITS.maxPageDimensionPt || heightPt > PDF_RASTER_LIMITS.maxPageDimensionPt)
    throw new Error('PDF page dimensions exceed rendering bounds.');
  const widthPx = Math.ceil(widthPt * PDF_RASTER_LIMITS.scale);
  const heightPx = Math.ceil(heightPt * PDF_RASTER_LIMITS.scale);
  if (!Number.isSafeInteger(widthPx) || !Number.isSafeInteger(heightPx) ||
      widthPx < 1 || heightPx < 1 ||
      widthPx > PDF_RASTER_LIMITS.maxRasterDimensionPx || heightPx > PDF_RASTER_LIMITS.maxRasterDimensionPx)
    throw new Error('PDF raster dimensions exceed rendering bounds.');
  const pagePixels = widthPx * heightPx;
  const totalPixels = priorPixels + pagePixels;
  const pageRgbaBytes = pagePixels * 4;
  const totalRgbaBytes = totalPixels * 4;
  if (!Number.isSafeInteger(pagePixels) || pagePixels > PDF_RASTER_LIMITS.maxPagePixels ||
      pageRgbaBytes > PDF_RASTER_LIMITS.maxPageRgbaBytes)
    throw new Error('PDF page raster exceeds inspection budget.');
  if (!Number.isSafeInteger(totalPixels) || totalPixels > PDF_RASTER_LIMITS.maxTotalPixels ||
      totalRgbaBytes > PDF_RASTER_LIMITS.maxTotalRgbaBytes)
    throw new Error('Document raster exceeds inspection budget.');
  return { widthPx, heightPx, pagePixels, totalPixels, pageRgbaBytes, totalRgbaBytes };
}

export async function withRasterDeadline<T>(operation: Promise<T>, timeoutMs = PDF_RASTER_LIMITS.timeoutMs): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > PDF_RASTER_LIMITS.timeoutMs)
    throw new Error('Invalid PDF raster deadline.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('PDF rasterization timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Rasterize the actual PDF bytes and extract their text, not screenshots of the source DOM. */
export async function rasterizePdf(browser: Browser, pdf: Buffer, options?: { deadlineMs?: number }) {
  if (pdf.length > 8_000_000 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invalid or oversized PDF.');
  const deadlineMs = options?.deadlineMs ?? PDF_RASTER_LIMITS.timeoutMs;
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  try {
    const [main, worker] = await Promise.all([script('pdfjs-dist/build/pdf.min.mjs'), script('pdfjs-dist/build/pdf.worker.min.mjs')]);
    const pages = await withRasterDeadline((async () => {
      // Preflight parses page geometry only. No canvas is created until every
      // page has passed finite-dimension, per-page, aggregate-pixel and RGBA
      // memory budgets in the server process.
      const preflight = await page.evaluate(async ({ main, worker, data, maxPages }) => {
        const url = URL.createObjectURL(new Blob([main], { type: 'text/javascript' }));
        const workerUrl = URL.createObjectURL(new Blob([worker], { type: 'text/javascript' }));
        const pdfjs = await new Function('url', 'return import(url)')(url);
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        let pdfDocument: any;
        try {
          pdfDocument = await pdfjs.getDocument({ data: Uint8Array.from(atob(data), c => c.charCodeAt(0)), isEvalSupported: false }).promise;
          if (pdfDocument.numPages > maxPages || pdfDocument.numPages < 1) throw new Error('PDF page count exceeds rendering bounds.');
          const dimensions: Array<{ widthPt: number; heightPt: number }> = [];
          for (let i = 1; i <= pdfDocument.numPages; i++) {
            const pdfPage = await pdfDocument.getPage(i);
            try {
              const natural = pdfPage.getViewport({ scale: 1 });
              dimensions.push({ widthPt: natural.width, heightPt: natural.height });
            } finally {
              pdfPage.cleanup();
            }
          }
          return dimensions;
        } finally {
          if (pdfDocument) await pdfDocument.destroy().catch(() => undefined);
          URL.revokeObjectURL(url);
          URL.revokeObjectURL(workerUrl);
        }
      }, { main, worker, data: pdf.toString('base64'), maxPages: PAGE.maxPages });

      let totalPixels = 0;
      const expected = preflight.map(({ widthPt, heightPt }) => {
        const checked = validatePdfRasterPageGeometry(widthPt, heightPt, totalPixels);
        totalPixels = checked.totalPixels;
        return { widthPt, heightPt, widthPx: checked.widthPx, heightPx: checked.heightPx };
      });

      return page.evaluate(async ({ main, worker, data, maxPages, limits, expected }) => {
        const url = URL.createObjectURL(new Blob([main], { type: 'text/javascript' }));
        const workerUrl = URL.createObjectURL(new Blob([worker], { type: 'text/javascript' }));
        const pdfjs = await new Function('url', 'return import(url)')(url);
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        let pdfDocument: any;
        try {
          pdfDocument = await pdfjs.getDocument({ data: Uint8Array.from(atob(data), c => c.charCodeAt(0)), isEvalSupported: false }).promise;
          if (pdfDocument.numPages !== expected.length || pdfDocument.numPages > maxPages || pdfDocument.numPages < 1)
            throw new Error('PDF page count changed after geometry preflight.');
          const results: Array<{ png: string; text: string; fragments: PdfTextFragment[]; fontSizesPt: number[]; overflow: boolean; blank: boolean }> = [];
          for (let i = 1; i <= pdfDocument.numPages; i++) {
            const pdfPage = await pdfDocument.getPage(i);
            let canvas: HTMLCanvasElement | null = null;
            try {
              const expectedPage = expected[i - 1];
              const natural = pdfPage.getViewport({ scale: 1 });
              if (!Number.isFinite(natural.width) || !Number.isFinite(natural.height) ||
                  Math.abs(natural.width - expectedPage.widthPt) > 0.01 ||
                  Math.abs(natural.height - expectedPage.heightPt) > 0.01)
                throw new Error('PDF page geometry changed after preflight.');
              const viewport = pdfPage.getViewport({ scale: limits.scale });
              const canvasWidth = Math.ceil(viewport.width), canvasHeight = Math.ceil(viewport.height);
              if (!Number.isSafeInteger(canvasWidth) || !Number.isSafeInteger(canvasHeight) ||
                  canvasWidth !== expectedPage.widthPx || canvasHeight !== expectedPage.heightPx)
                throw new Error('PDF raster geometry changed after preflight.');

              // Allocation happens only after the preflight and exact geometry
              // recheck above have passed.
              canvas = window.document.createElement('canvas');
              canvas.width = canvasWidth;
              canvas.height = canvasHeight;
              const ctx = canvas.getContext('2d');
              if (!ctx) throw new Error('PDF canvas allocation failed.');
              await pdfPage.render({ canvasContext: ctx, viewport }).promise;
              const content = await pdfPage.getTextContent();
              const items = content.items.filter((item: { str?: string }) => typeof item.str === 'string');
              type GlyphItem = { str: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number };
              const fragments: PdfTextFragment[] = new Array(items.length);
              let nextVisible: GlyphItem | null = null;
              for (let j = items.length - 1; j >= 0; j--) {
                const item = items[j] as GlyphItem;
                const x = item.transform?.[4], y = item.transform?.[5];
                const nextX = nextVisible?.transform?.[4], nextY = nextVisible?.transform?.[5];
                const lineBreakAfter = typeof x === 'number' && typeof y === 'number' &&
                  typeof nextX === 'number' && typeof nextY === 'number' &&
                  Number.isFinite(x) && Number.isFinite(y) &&
                  Number.isFinite(nextX) && Number.isFinite(nextY) &&
                  y - nextY > Math.max(3, (item.height ?? 0) * 0.35) &&
                  nextX + 1 < x + Math.max(2, item.width ?? 0);
                fragments[j] = { str: item.str, hasEOL: Boolean(item.hasEOL), ...(lineBreakAfter ? { lineBreakAfter: true } : {}) };
                if (item.str.trim()) nextVisible = item;
              }
              const fontSizesPt = items.filter((item: { str: string }) =>
                item.str.trim() && !/^[•●]$/.test(item.str.trim())
              ).map((item: { transform: number[] }) => Math.hypot(item.transform[2], item.transform[3]));
              const overflow = items.some((item: { str: string; transform: number[]; width: number; height: number }) => {
                const x = item.transform[4], y = item.transform[5];
                return item.str.trim() && (x < 1 || y < 1 || x + item.width > natural.width + 1 || y + item.height > natural.height + 1);
              });
              const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
              let ink = 0;
              for (let offset = 0; offset < pixels.length; offset += 4)
                if (pixels[offset] < 180 && pixels[offset + 1] < 180 && pixels[offset + 2] < 180) ink++;
              results.push({
                png: canvas.toDataURL('image/png'),
                text: items.map((item: { str: string; hasEOL: boolean }) => item.str + (item.hasEOL ? '\n' : '')).join(''),
                fragments, fontSizesPt, overflow, blank: ink < 40,
              });
            } finally {
              if (canvas) canvas.width = canvas.height = 1;
              pdfPage.cleanup();
            }
          }
          return results;
        } finally {
          if (pdfDocument) await pdfDocument.destroy().catch(() => undefined);
          URL.revokeObjectURL(url);
          URL.revokeObjectURL(workerUrl);
        }
      }, { main, worker, data: pdf.toString('base64'), maxPages: PAGE.maxPages, limits: PDF_RASTER_LIMITS, expected });
    })(), deadlineMs);

    const images = pages.map(p => Buffer.from(p.png.split(',')[1], 'base64'));
    if (images.reduce((sum, b) => sum + b.length, 0) > 12_000_000) throw new Error('Document raster exceeds inspection budget.');
    return { images, pageTexts: pages.map(p=>p.text), fontMeasurements: pages.map((p,i)=>({ page:i+1, minimumPt: p.fontSizesPt.length ? Math.min(...p.fontSizesPt) : null, sizesPt:[...new Set(p.fontSizesPt)] })), text: pages.map(p => p.text).join('\n'), fragments: pages.flatMap((p, i) => i === 0 ? p.fragments : [{str:'',hasEOL:true},...p.fragments]), findings: pages.flatMap((p, i): Finding[] => [
      ...(p.fontSizesPt.some(size => !Number.isFinite(size) || size < PAGE.font) ? [{ rule: 'font-size' as const, page: i + 1, detail: 'Actual PDF text is below the approved 11-point minimum.' }] : []),
      ...(p.overflow ? [{ rule: 'overflow' as const, page: i + 1, detail: 'PDF text lies outside page bounds.' }] : []),
      ...(p.blank ? [{ rule: 'whitespace' as const, page: i + 1, detail: 'Rasterized PDF page has no readable ink.' }] : []),
    ]) };
  } finally {
    await context.close();
  }
}
