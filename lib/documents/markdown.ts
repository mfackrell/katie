/** Plain-text projection of the existing finite Markdown grammar.
 * CommonMark punctuation escapes are syntax, not source-content edits.
 * Protect literal escapes and code FIRST so later formatting cannot activate
 * escaped delimiters or rewrite code. No HTML, execution or external I/O.
 */
const asciiPunctuation = (character: string): boolean => /^[!-/:-@[-`{-~]$/.test(character);

type ProtectedInline = { text: string; restore: (text: string) => string };
function protectLiterals(value: string): ProtectedInline {
  // Select a namespace absent from this input; authored text can never alias a
  // protected token, including documents deliberately containing private-use chars.
  let prefix = '\uE000';
  while (value.includes(prefix)) prefix += '\uE000';
  const literals: string[] = [];
  const protect = (literal: string) => prefix + (literals.push(literal) - 1) + '\uE001';
  let text = '';
  for (let i = 0; i < value.length;) {
    if (value[i] === '\\' && i + 1 < value.length && asciiPunctuation(value[i + 1])) {
      text += protect(value[i + 1]); i += 2; continue;
    }
    if (value[i] === '`') {
      let end = i; while (value[end] === '`') end++;
      const width = end - i;
      let closing = -1, after = end;
      while (after < value.length) {
        const candidate = value.indexOf('`', after);
        if (candidate < 0) break;
        after = candidate; while (value[after] === '`') after++;
        if (after - candidate === width) { closing = candidate; break; }
      }
      if (closing >= 0) {
        // In code spans backslashes and Markdown punctuation are literal.
        let literal = value.slice(end, closing).replace(/\r\n?|\n/g, ' ');
        if (literal.startsWith(' ') && literal.endsWith(' ') && /[^ ]/.test(literal))
          literal = literal.slice(1, -1);
        text += protect(literal); i = after; continue;
      }
      text += value.slice(i, end); i = end; continue; // unmatched ticks are literal
    }
    text += value[i++];
  }
  const pattern = new RegExp(prefix + '(\\d+)\uE001', 'g');
  return { text, restore: masked => masked.replace(pattern, (_match, index: string) => literals[Number(index)]) };
}

// Keep the established supported links and strong-emphasis projection; this
// change does not introduce a new Markdown dialect or rewrite document prose.
function formatInline(masked: string): string {
  return masked.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').trim();
}
export function markdownInlineText(value: string): string {
  const protectedValue = protectLiterals(value);
  return protectedValue.restore(formatInline(protectedValue.text));
}

/** Split before unescaping, so an escaped pipe is a cell glyph, not a column.
 * Code spans use the same protection as headings/paragraphs/list items.
 */
export function markdownTableRow(value: string): string[] {
  const protectedValue = protectLiterals(value.trim());
  return protectedValue.text.replace(/^\|/, '').replace(/\|$/, '').split('|')
    .map(cell => protectedValue.restore(formatInline(cell)));
}
