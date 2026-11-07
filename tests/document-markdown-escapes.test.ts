import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { markdownInlineText, markdownTableRow } from '../lib/documents/markdown';
import { parseDocument, contentText } from '../lib/documents/model';

test('ASCII punctuation escapes are interpreted exactly once without changing source bytes', () => {
  const punctuation = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
  for (const mark of punctuation) assert.equal(markdownInlineText('\\' + mark), mark);
  const source = String.raw`Revenue \$25M; bracket \[verified\]; asterisk \*literal\*.`;
  const sha = () => createHash('sha256').update(source).digest('hex');
  const original = sha();
  assert.equal(markdownInlineText(source), 'Revenue $25M; bracket [verified]; asterisk *literal*.');
  assert.equal(sha(), original, 'Interpretation must never edit the approved source');
});

test('literal backslashes, paths, non-punctuation, and odd/even escape runs remain unambiguous', () => {
  assert.equal(markdownInlineText(String.raw`C:\Users\Owner\report.txt`), String.raw`C:\Users\Owner\report.txt`);
  assert.equal(markdownInlineText(String.raw`\A \1 \é \空`), String.raw`\A \1 \é \空`);
  assert.equal(markdownInlineText('trailing\\'), 'trailing\\');
  assert.equal(markdownInlineText(String.raw`\\`), '\\');
  assert.equal(markdownInlineText(String.raw`\\$25`), String.raw`\$25`);
  assert.equal(markdownInlineText(String.raw`\\\$25`), String.raw`\$25`);
  assert.equal(markdownInlineText(String.raw`\\\\$25`), String.raw`\\$25`);
  assert.equal(markdownInlineText('`C:\\_cache\\report.txt`'), 'C:\\_cache\\report.txt');
  assert.equal(markdownInlineText('`\\\\server\\share`'), '\\\\server\\share');
});

test('code spans protect escapes, formatting markers and embedded backticks', () => {
  assert.equal(markdownInlineText('`\\$25 **literal** [x](y)`'), '\\$25 **literal** [x](y)');
  assert.equal(markdownInlineText('``a ` b \\$25``'), 'a ` b \\$25');
  assert.equal(markdownInlineText('```inline `code` \\$25```'), 'inline `code` \\$25');
  assert.equal(markdownInlineText('` unmatched'), '` unmatched');
  assert.equal(markdownInlineText('` a  b `'), 'a  b');
  assert.equal(markdownInlineText('`   `'), '   ');
  assert.equal(markdownInlineText('**`\\$25`**'), '\\$25');
  assert.equal(markdownInlineText('\\`literal\\`'), '`literal`');
});

test('escaped formatting cannot become active markup after unescaping', () => {
  assert.equal(markdownInlineText(String.raw`\*\*literal\*\* and **strong**`), '**literal** and strong');
  assert.equal(markdownInlineText(String.raw`\[label](target)`), '[label](target)');
  assert.equal(markdownInlineText(String.raw`[label]\(target\)`), '[label](target)');
  assert.equal(markdownInlineText('\uE0000\uE001 \\$5'), '\uE0000\uE001 $5');
  assert.equal(markdownInlineText('[Cost \\$5](https://example.test/a\\(b\\))'), 'Cost $5 (https://example.test/a(b))');
});

test('identical semantic interpretation applies to headings, paragraphs, bullets and table cells', () => {
  const source = '# Cost \\$5\n\n**Section \\$6**\n\nBody \\$7\n\n- Item \\$8\n\n| Label | Cost |\n| --- | --- |\n| A\\|B | \\$9 |\n| `x|y` | `\\$10` |';
  const spec = parseDocument(source, 2);
  assert.deepEqual(spec.blocks.slice(0,4).map(block => 'text' in block ? block.text : ''),
    ['Cost $5','Section $6','Body $7','Item $8']);
  assert.deepEqual(spec.blocks[4], {kind:'table',rows:[['Label','Cost'],['A|B','$9'],['x|y','\\$10']]});
  assert.equal(spec.targetPages,2);
  assert.equal((contentText(spec).match(/\\\$/g) ?? []).length,1,'Only explicitly literal code escape survives');
  assert.deepEqual(markdownTableRow(String.raw`| \| | \\ |`), ['|','\\']);
});

test('escaped block delimiters remain text and unsafe/fenced formats remain rejected', () => {
  const spec = parseDocument(String.raw`\# literal heading` + '\n\n' + String.raw`\- literal bullet`);
  assert.deepEqual(spec.blocks.map(b=>b.kind),['paragraph','paragraph']);
  assert.equal(contentText(spec),'# literal heading\n- literal bullet');
  assert.throws(()=>parseDocument('```html\n<script>x</script>\n```'),/unsupported/);
  assert.throws(()=>parseDocument('<script>alert(1)</script>'),/unsupported/);
  assert.throws(()=>parseDocument('![remote](https://example.test/x.png)'),/unsupported/);
  assert.equal(contentText(parseDocument('A ```inline `code` \\$25``` example.')), 'A inline `code` \\$25 example.');
});
