# PR #997 — agreement cross-render investigation

## Decision and scope

Preserve document-engine implementation at `39893dd95a0db1bdd98e3e3b0fe857dbf4b08b09`.
No one-page formatting correction is justified merely by this agreement's page count:
there is **no explicit one-page requirement**. The version discrepancy is real,
however, and remains a failure of the separate `DOCX_OFFICE_PARITY` requirement.
No requirement is waived, no professional appearance is self-approved, and no
counterfactual is promoted to a finished artifact.

The same draft PR incorporates current main; no production release is authorized.
Changes in this investigation are diagnostic scripts/tests, CI evidence, and this
report, not the Markdown parser, font floor, source identity, or pagination engine.

## The exact triggering input

`tests/document-phase1-qualification.test.ts` supplies `pages: undefined` for
`phase1-business-agreement.md`; the Phase 2 composition test likewise calls
`parseDocument(markdown)` without a target. Generated metadata records
`required_pages: null`. A two-page result is therefore **not** a breach of an
explicit one-page constraint. An independently imposed equal-page-count contract
is a different requirement and is not satisfied by that observation.

The approved synthetic agreement contains 31 semantic blocks / 40 rendered text
lines, one Word section, zero tables, and zero explicit page breaks. Page size is
612 x 792 points with 36-point margins (720-point content height; bottom at y=756).
Body runs are 11pt; title/section/subsection runs are 19/13.5/11.5pt. Final paragraph
spacing is 6pt after, with heading-before spacing 3pt (title 6pt).

`lib/documents/generate.ts` paragraph spacing, table-cell spacing and document
defaults emit `w:line="240"` in compact mode **without `w:lineRule`**. That omitted
attribute is the causal switch, not a forced section boundary or missing content.

## Controlled experiment: both versions on the same machine

Official LibreOffice 24.2.7.2 (ee3885777aa7032db5a9b65deec9457448a91162) and
LibreOffice 26.2.6.3 were run on the same private Ubuntu 26.04 machine. The same
installed Liberation Sans regular/bold files service Arial in both versions.
All five DOCX variants retain identical text and font declarations. Only the
stated diagnostic attribute is changed; the original is copied byte-for-byte.

| Variant | LibreOffice 24.2.7.2 | LibreOffice 26.2.6.3 | Chromium |
|---|---:|---:|---:|
| Original: lineRule omitted | 1 | 2 | 1 |
| Explicit proportional `auto` | 2 | 2 | 1 |
| Explicit fixed `exact` | 1 | 1 | 1 |
| Taller page, otherwise unchanged | 1 | 1 | Not a delivery candidate |
| Remove keepNext, otherwise unchanged | 1 | 2 | Not a delivery candidate |

FODT exports expose the **imported** line-spacing interpretation independently of
PDF extraction: old LibreOffice imports the original as `fo:line-height="0.1665in"`
(approximately 12pt; actual baseline increment 12.000pt); new LibreOffice imports
it as `100%`. Explicit auto makes both import it as 100%; explicit exact makes both
use the fixed height. This is direct evidence, not an inferred version label.

The pinned `docx-preview@0.4.1` `parseSpacing()` uses `line / 20` point line-height
in its default branch (including omitted lineRule). Only explicit auto uses
`line / 240` CSS unitless line-height. Thus the browser currently follows the
fixed-height interpretation for the original DOCX. CSS unitless auto also uses a
different line-box convention from Writer's natural single spacing, so merely
adding auto does **not** establish three-renderer page parity.

## Geometry and font metrics

Regular and bold Liberation Sans share hhea ascender=1854, descender=-434,
lineGap=67, unitsPerEm=2048. At 11pt this yields natural leading
`11 * (1854 + 434 + 67) / 2048 = 12.64892578125pt`, matching the observed 12.65pt
Writer 26 baseline increment. The old fixed interpretation uses 12.00pt.
The 40 ordered line texts are identical; the maximum line-width difference
between office versions is only 0.099pt and causes **zero changed wraps**.

| Position | LO24 original | LO26 original/natural flow |
|---|---:|---:|
| First title glyph top | 34.405pt | 42.655pt |
| `Signatures` heading top | 579.3825pt | 637.5825pt |
| Last provider Date bottom | 647.921pt | 709.171pt |
| Client heading if no page boundary | 653.1925pt | 715.5925pt |
| Last client Date bottom in continuous flow | 701.921pt | 765.721pt |

The tall-page diagnostic measures the whole natural flow: the final client date
ends **9.721pt below** the Letter content boundary. The cumulative vertical
increase is 63.800pt. `keepNext` correctly moves the Client heading, representative,
and date together to page 2; page 2 contains those three intact lines only.
Removing keepNext strands the final date on page 2 instead. This falsifies the
hypothesis that a gratuitous forced section caused the transition.

Table geometry is excluded for the agreement because its table count is zero.
The separate financial-report fixture remains the table generalization case.

## Why neither counterfactual is a production fix

Fixed 12pt leading recreates the old one-page rendering, but its 19pt title has a
21.204pt glyph box: the title top is 1.595pt above the 36pt content margin. Fixed
12pt lines are not a safe universal rule for larger/multiline headings. A passing
page count alone cannot authorize this candidate.

Explicit auto normalizes the two Office versions but still disagrees with
Chromium (2/2/1); it cannot close `DOCX_OFFICE_PARITY`. Removing continuity moves
only the date and is a regression. Shrinking fonts, changing source wording,
changing Letter margins, or inventing targetPages=1 are not permitted remedies.

No production formatting change was adopted. Strict page parity remains
**FAIL/PENDING** until a general line-box/pagination policy is implemented and
qualified, or the owner explicitly changes that acceptance requirement. The
absence of a page cap is not an implicit amendment of that contract.

## Reproduction and review handoff

Compile and run the existing actual-generation fixtures first. Then run:

```sh
python3 tests/document-cross-render-policy.test.py
python3 scripts/document-cross-render-investigation.py \
  --docx test-artifacts/documents/phase1/business-agreement.docx \
  --metadata test-artifacts/documents/phase1/business-agreement.json \
  --office lo24=/absolute/path/to/soffice24 \
  --office lo26=/absolute/path/to/soffice26 \
  --output /private-or-synthetic-evidence/cross-render
```

The runner performs no downloads or inference. Use isolated LO profiles and
wrapper executables for version-specific runtime libraries. It records actual
PDFs, source hashes, imported paragraph styles, line coordinates, page images,
and separate page-cap/parity verdicts. `original` is the review artifact;
`counterfactuals` are experiments, never approved deliverables.

Independent review must examine the actual original résumé/report/agreement
images, including the two-page LO26 agreement, and identify findings by artifact
hash and page. No mandatory visual gate is automatically closed by this report.

Reference for line units and fixed-height clipping behavior: Microsoft Open XML
SpacingBetweenLines.Line documentation, ISO/IEC 29500-1 section 17.3.1.33:
https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.spacingbetweenlines.line
