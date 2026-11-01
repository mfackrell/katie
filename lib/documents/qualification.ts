import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { documentSchema } from './model';
import { produceDocument } from './production';
import { sha256 } from './render';

// Reviewed raster fingerprints of the fixed synthetic fixture, with pinned Arimo
// fonts, Chromium 148 and PDF.js 5.4.624. Not a substitute for arbitrary-document vision.
export const QUALIFIED_PAGES = [
  '5c2f9e160bcc6da7c42b39c7743948e4c4638e4ec20865dec0abcc5de4e234b8',
  'a8517e0e01a1ef3d32485dce2a6441452098bfb81e0d8d697a51e93d079844f3',
];
export async function qualifyDocument(browser: Browser, deadlineMs: number) {
  const spec = documentSchema.parse(JSON.parse(await readFile(join(process.cwd(), 'fixtures/documents/executive-resume.json'), 'utf8')));
  return produceDocument({ spec, browser, deadlineMs,
    // Deliberately place all content on one page. The production detector and
    // repair path must catch overflow and rebuild the real DOCX before acceptance.
    initialLayout: { pages: [spec.blocks.map((_, i) => i)], spacing: 4 },
    inspect: async rendered => {
      if (rendered.images.length !== QUALIFIED_PAGES.length || rendered.images.some((image, i) => sha256(image) !== QUALIFIED_PAGES[i]))
        throw new Error('Qualification raster changed; independent visual review is required.');
      return { pages: rendered.images.map((_, i) => ({ page: i + 1, verdict: 'pass' as const, repair: 'none' as const,
        observations: 'Actual PDF raster exactly matches the independently inspected fixed-fixture baseline, including text placement, margins and page balance.' })) };
    },
  });
}
