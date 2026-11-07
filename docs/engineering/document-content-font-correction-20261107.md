# PR #997 — semantic escapes and PDF font floor

Scope: two demonstrated private-acceptance defects only. No pagination redesign,
authority change, provider call, deployment, dependency change, or manuscript edit.

## Markdown semantic projection

The approved source remains immutable. The bounded parser interprets ASCII
punctuation escapes outside code spans, before projecting supported inline
formatting. Escaped delimiters cannot activate markup. Literal backslashes,
non-punctuation escapes, unmatched backticks, code-span punctuation and Windows
paths retain their intended semantic characters. Table splitting protects escaped
pipes and code spans before recognizing column separators. The same helper serves
headings, paragraphs, list items and cells. Fenced and executable formats remain
rejected. Reference: https://spec.commonmark.org/0.31.2/#backslash-escapes and
https://spec.commonmark.org/0.31.2/#code-spans .

Fidelity compares the interpreted semantic document, not Markdown control bytes.
The raw manuscript SHA-256 is still checked before private execution.

## Font investigation and correction

The failure is real font quantization, not merely PDF.js display rounding.
OOXML w:sz=22 and document defaults declare 11pt. docx-preview 0.4.1 emits 11pt.
Chromium 148 computes 14.6667px; CDP identifies the pinned embedded Arimo-Regular
font, not a substituted font. PDF operators contain Tf=14.6599998 and page CTM
0.23999999 times 3.125. Their product is 10.994999391875005pt. The approximately
0.005pt loss is about 8,200 times the sub-micro-point matrix representation error.
A plain synthetic HTML specimen reproduces it independently of DOCX generation.

The renderer raises only floor-sized text to ceil(11*96/72*100)/100 = 14.67px,
an upward change of 0.003333333px. The resulting Tf=14.6700001 yields
11.002499616562496pt. Source OOXML stays 11pt. There is NO tolerance accepting a
value below 11pt, no downward rounding, no PDF rescaling and no content deletion.
Actual vertical PDF em-vector magnitudes are checked, not glyph ink rectangles.
Sub-minimum text now produces a hard font-size finding. Generated list-marker
bullet decoration is excluded; body, headings and table text are not.

The existing independently pinned synthetic raster hashes remain unchanged after
this subpixel correction. Their assertions are preserved, not updated to new
unreviewed fingerprints. This says nothing about final private visual approval.

## Reproducible evidence

- tests/document-markdown-escapes.test.ts: six positive/negative semantic tests.
- tests/document-content-font.test.ts: actual DOCX/PDF semantic preservation,
  upward-only correction bound, real font-floor measurement and rejection tests.
- scripts/document-font-investigation.mjs: CSS, CDP font, PDF Tf/CTM and transform
  probes; synthetic outputs only, no network/provider dependency.
- scripts/document-phase2-private-acceptance.mjs: exact commit + unchanged raw SHA,
  actual two-page Chromium/LibreOffice PDFs, semantic glyph fidelity, font vectors,
  heading/support and level-3 group continuity; outputs outside Git and CI.

Independent professional visual acceptance remains separate. No pending visual
criterion can be closed by the implementation agent or a simulated inspector.

## Additional office-version limitation

The local Ubuntu 26.04 / LibreOffice 26.2.6.3 environment places the synthetic
business agreement on two office pages while Chromium produces one. The same
discrepancy was reproduced on the unchanged qualified baseline 46500b5.
word/document.xml and word/styles.xml are byte-identical before/after these
corrections. This is therefore not introduced by escape or font correction,
but it remains an unresolved cross-render acceptance result in that environment.
Do not claim universal Office parity from the Ubuntu 24.04 CI renderer.
