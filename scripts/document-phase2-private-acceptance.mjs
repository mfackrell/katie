#!/usr/bin/env node
/**
 * Owner-private Phase 2 acceptance runner.
 *
 * This script NEVER downloads content, contacts a model, or copies source into
 * GitHub/CI. Compile the existing tests with 'tsc -p tsconfig.tests.json',
 * then run on a trusted local host with an approved Markdown file outside the
 * repo and its externally verified exact SHA256.
 *
 * Example:
 *   KATIE_PRIVATE_SOURCE_SHA256=<verified-sha> node scripts/document-phase2-private-acceptance.mjs /private/approved.md /private/evidence
 *
 * Reported mechanical acceptance is not independent professional-design PASS.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const repo = resolve(process.cwd());
const [sourceArg, outputArg] = process.argv.slice(2);
if (process.env.GITHUB_ACTIONS === 'true') throw Error('Private source must never run in GitHub Actions');
if (!sourceArg || !outputArg || !/^[a-f0-9]{64}$/i.test(process.env.KATIE_PRIVATE_SOURCE_SHA256 ?? '')) {
  throw Error('Expected private source path, private output directory, and exact KATIE_PRIVATE_SOURCE_SHA256');
}
const sourcePath = resolve(sourceArg), output = resolve(outputArg);
if ([sourcePath, output].some(p => p === repo || p.startsWith(repo + sep))) {
  throw Error('Approved private content and rendered outputs must remain outside the public repository');
}
if (!existsSync(sourcePath)) throw Error('Approved private source path does not exist');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const raw = readFileSync(sourcePath);
const actual = sha(raw);
if (actual.toLowerCase() !== process.env.KATIE_PRIVATE_SOURCE_SHA256.toLowerCase())
  throw Error('The private source does not match the approved source SHA256; no files generated');
const { parseDocument, contentText, normalizedText } = require('../.test-dist/lib/documents/model.js');
const { produceDocument } = require('../.test-dist/lib/documents/production.js');
const { launchWebsiteBrowser } = require('../.test-dist/lib/research/website-evidence.js');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const spec = parseDocument(raw.toString('utf8'), 2);
mkdirSync(output, { recursive: true });
const browser = await launchWebsiteBrowser();
let result;
try {
  result = await produceDocument({
    spec, browser, deadlineMs: Date.now() + 110_000,
    // A deterministic blocked design report keeps qualification offline.
    // Independent visual review is separate and mandatory.
    inspect: async rendered => ({
      pages: rendered.images.map((_, i) => ({
        page: i + 1, verdict: 'pass', repair: 'none',
        observations: 'Rendered page was examined mechanically only; professional design has not been approved.',
      })),
      design: {
        verdict: 'blocked', actions: [], comparison: 'not_applicable',
        summary: 'Independent professional visual quality acceptance has not yet been performed.',
        issues: [{ page: 0, category: 'other', severity: 'material',
          evidence: 'A separate reviewer must inspect final Word and PDF raster pages.' }],
      },
    }),
  });
} finally { await browser.close(); }
if (result.inspection.findings.length || result.inspection.pageCount !== 2)
  throw Error('Hard two-page or mechanical fidelity requirement failed; no successful acceptance claimed');
const docxContent = await mammoth.extractRawText({ buffer: result.docx });
if (normalizedText(docxContent.value) !== normalizedText(contentText(spec)))
  throw Error('DOCX extraction differs from approved content; no successful acceptance claimed');
const xml = await JSZip.loadAsync(result.docx);
const docXml = await xml.file('word/document.xml').async('string');
const sizeHits = [...docXml.matchAll(/<w:sz\b[^>]*\bw:val="(\d+)"/g)].map(match => Number(match[1]));
if (!sizeHits.length || Math.min(...sizeHits) < 22) throw Error('Body run font violates 11pt minimum');
const candidate = join(output,'katie-private-candidate');
writeFileSync(candidate+'.docx',result.docx);
writeFileSync(candidate+'.pdf',result.pdf);
result.images.forEach((bytes,i)=>writeFileSync(candidate+'-browser-page-'+(i+1)+'.png',bytes));
const officeDir=join(output,'office');
mkdirSync(officeDir,{recursive:true});
const profile=mkdtempSync(join(tmpdir(),'katie-private-lo-'));
let officePages;
try {
  execFileSync('soffice',['-env:UserInstallation=file://'+profile,'--headless','--convert-to','pdf','--outdir',officeDir,candidate+'.docx'],
    {timeout:90000,stdio:'pipe'});
  const info=execFileSync('pdfinfo',[join(officeDir,'katie-private-candidate.pdf')],{encoding:'utf8',timeout:30000});
  officePages=Number(info.match(/^Pages:\s*(\d+)\s*$/m)?.[1]);
  for(let p=1;p<=officePages;p++)
    execFileSync('pdftoppm',['-f',String(p),'-l',String(p),'-singlefile','-scale-to','1400','-png',
      join(officeDir,'katie-private-candidate.pdf'),join(officeDir,'page-'+p)],{timeout:30000,stdio:'pipe'});
}finally{rmSync(profile,{recursive:true,force:true})}
const evidence = {
  private_source_sha256: actual,
  source_characters: raw.toString('utf8').length,
  source_approved_requirement_pages: 2,
  actual_browser_pdf_pages: result.inspection.pageCount,
  actual_office_pdf_pages: officePages,
  minimum_explicit_run_half_points: Math.min(...sizeHits),
  document_word_text_preserved: true,
  document_pdf_fidelity_findings: result.inspection.findings,
  document_sha256: sha(result.docx), browser_pdf_sha256: sha(result.pdf),
  rendered_page_image_hashes: result.images.map(sha),
  visual_status: result.inspection.visual,
  independent_visual_review: 'PENDING - must not be represented as passed',
  release_gate: officePages===2?'MECHANICAL ONLY; INDEPENDENT REVIEW PENDING':'FAILED - Word/PDF page discrepancy',
};
writeFileSync(join(output,'qualification.json'),JSON.stringify(evidence,null,2)+'\n');
if (officePages!==2) throw Error('Office and Chromium do not agree on exact two-page requirement');
console.log(JSON.stringify({private_source_sha256:actual,chromium_pages:2,office_pages:2,
  min_body_font_pt:Math.min(...sizeHits)/2,professional_acceptance:'PENDING'}));
