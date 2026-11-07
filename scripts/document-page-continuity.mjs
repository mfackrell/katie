/** Map already-normalized source blocks to physical PDF pages by ordered
 * glyph offsets. Repeated headings cannot alias earlier matching words.
 * Exact whole-document equality is mandatory before mapping; do not fuzzy-match.
 */
export function orderedBlockPages(blockGlyphs, pageGlyphs) {
  if (!Array.isArray(blockGlyphs) || !Array.isArray(pageGlyphs) ||
      !blockGlyphs.length || !pageGlyphs.length ||
      [...blockGlyphs,...pageGlyphs].some(value=>typeof value!=='string' || !value.length))
    throw Error('Missing source or rendered-page glyphs');
  if (blockGlyphs.join('')!==pageGlyphs.join(''))
    throw Error('Rendered pages do not preserve exact ordered source glyphs');
  let end=0;
  const ends=pageGlyphs.map(page=>end+=page.length);
  let offset=0;
  return blockGlyphs.map(block=>{
    const start=offset; offset+=block.length;
    return ends.flatMap((boundary,i)=>start<boundary && offset>(i?ends[i-1]:0)?[i+1]:[]);
  });
}
