import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve('test-artifacts/documents'), output = join(root, 'libreoffice');
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'katie-word-'));
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
try {
  run('soffice', [`-env:UserInstallation=file://${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', output, join(root, 'executive-resume.docx')]);
  const pdf = join(output, 'executive-resume.pdf');
  const info = run('pdfinfo', [pdf]);
  if (!/^Pages:\s+2\s*$/m.test(info)) throw new Error('The standard office renderer did not produce exactly two pages.');
  const extracted = run('pdftotext', [pdf, '-']);
  const spec = JSON.parse(readFileSync('fixtures/documents/executive-resume.json', 'utf8'));
  const normalize = value => value.normalize('NFKC').replace(/[•●]/g, '').replace(/\s+/g, ' ').trim();
  if (normalize(extracted) !== normalize(spec.blocks.map(block => block.text ?? block.rows.flat().join(' ')).join('\n')))
    throw new Error('Standard office application changed content or reading order.');
  for (let page = 1; page <= 2; page++) run('pdftoppm', ['-f', String(page), '-singlefile', '-scale-to', '1400', '-png', pdf, join(output, `page-${page}`)]);
  console.log('LibreOffice acceptance: DOCX opens, exactly two pages, all fixture content in logical reading order; actual page PNGs retained.');
} finally { rmSync(profile, { recursive: true, force: true }); }
