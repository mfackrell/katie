import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { documentSchema } from './model';
import { produceDocument } from './production';
import { sha256 } from './render';

// Synthetic two-page fixture independently inspected 2026-11-02 from CI run 41544220652.
// Readable hierarchy and no clipping; second page continues the bullet list.
// Pinned raster fingerprints catch technical drift, not general design quality.
export const QUALIFIED_PAGES = [
  'a60404323d66e76baaac5b3134ba513f099d5b06e420a6f2e4f7f3792d9d1564',
  'db7d776fa457085bad17f21e4b08fce7f0e261e154a0979b6f8861936f586b42',
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
