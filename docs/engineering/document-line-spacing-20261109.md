# PR #997: final cross-render line-spacing qualification

## Scope and policy

Continue the existing PR; preserve the resolved Markdown, font-floor and private
source controls. Reconcile main 4fcfb609a04d52ba857cb009e7921ca0ebb483ff without
changing unrelated Task 4A, chat, security or accounting code.

The only production correction is in `lib/documents/generate.ts`: explicitly emit
`w:lineRule="exact"` and calculate each paragraph line box in twips from its actual
font size. Use at least 1.2 times that font size, retaining larger standard rhythm
and approved reviewer line-scale adjustments. Apply consistently to body text,
headings, table cells and document defaults. This is not fixed 12-point leading:
11pt compact body receives 13.2pt; 19pt title receives 22.8pt before bounded design
scaling. Font sizes, paragraph wording, margins and page-count provenance do not
change. The policy is qualified for the engine's supported Arial-compatible font
stack, not arbitrary font families or unsupported content types.

## Controlled before/after results

Actual generator output; no model inference. Same source bytes and same host fonts.
Versions: Chromium (pinned existing browser), LibreOffice 24.2.7.2 and 26.2.6.3.

| Acceptance case | Required pages | Before Chromium / LO24 / LO26 | After |
|---|---|---|---|
| Approved private resume | Exactly 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| Financial report | Not specified | 1 / 1 / 1 | 1 / 1 / 1 |
| Business agreement | Not specified | 1 / 1 / 2 | 1 / 1 / 1 |
| Large multiline heading safety fixture | Not specified | New regression | 1 / 1 / 1 |

The agreement's one-page output is an observation, not a new owner requirement.
All candidate PDFs preserve semantic glyph order, each tested content block,
heading support and complete level-three groups. All actual PDF body minima are
11.002499616562496pt in Chromium and 11pt in each Office version. The approved
private Markdown SHA remains b466561895813598f7b5b0f9f09cda5ca6e0f130e85f96c2369577e839900aa3.

The large-heading fixture explicitly increases hierarchy and line scale, wraps
its title over several lines, and checks actual glyph bounds in all renderers.
The margin auditor accounts only for one Chromium CSS coordinate quantum
(1/64 CSS pixel = 0.01171875pt) plus 0.00001pt PDF coordinate serialization.
It does not permit a smaller body font or significant margin encroachment.
Office line-wrap and page allocation agree; measured horizontal coordinate
variations below 0.173pt are recorded, not presented as pixel identity.

## Executable evidence

- `tests/document-line-spacing.test.ts`: explicit font-relative units, invalid
  inputs, actual paragraph/table/default declarations, large-heading raster and
  strict glyph/font checks.
- `scripts/document-cross-render-acceptance.mjs`: renders the exact DOCX through
  supplied version-specific Office executables; checks physical pages, actual
  PDF matrices, ordered semantic glyphs, block/group placement and printable
  bounds; saves final page images and per-line geometry.
- `scripts/document-phase2-private-acceptance.mjs`: unchanged source- and
  commit-bound private runner; execute only outside public CI with the original
  manuscript, then use the cross-render auditor for both Office versions.
- `fixtures/documents/phase2-mechanical-evidence.json`: sanitized actual-run
  hashes and measurements, with no manuscript, private text or images. The release
  gate rejects it after any engine-source or dependency-lock change.

The old independently approved fixed-raster fixture is deliberately NOT repinned.
Changed line boxes return technical-only rather than inherit obsolete design
approval. Its existing content, page, correction-cycle, secure delivery and
accounting assertions remain; new tests explicitly require invalidation of stale
visual approval.

## Acceptance boundary

Ten requirements have measured mechanical evidence. PAGE_COMPOSITION remains
pending a genuinely separate reviewer who examines the final private resume,
financial-report and agreement page images and records findings bound to their
artifact hashes. The implementation agent cannot supply that sign-off. The
release gate remains failing while this criterion is pending, independently of
full CI. No native Microsoft Word test was performed. No general claim is made
about untested font stacks or arbitrarily large multi-page tables.

No merge into main, production deployment, paid inference or database mutation.
Final exact-commit CI receipts and private-run artifact hashes are recorded in
PR #997 and the private review packet after execution.
