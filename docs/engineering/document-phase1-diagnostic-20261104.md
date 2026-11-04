# Document engine Phase 1 diagnostic — 2026-11-04

**Status: PARTIAL / PHASE 1 GATE NOT PASSED.** Diagnostic-only branch. Do not merge as a production fix.

## Baseline provenance
- Repository main at inspection: `9568bd821cd643de5509299715b6f6bac6f6afd2` (merged PR #994).
- PR #978, #983, #994 are already merged; PR #994 was not modified.
- Owner-provided rejected artifacts: `document(2).docx` (SHA256 `58b4d24d01783651e6ef4a9a5c9444f45822798fe9f19c8f6f178faa459d263f`) and `document-4.pdf` (SHA256 `53c3d4e95fed0cacd311e544cb3b067eacc9c4076d4f081f781f3f0f1f737806`).
- Personal résumé bytes excluded from Git history; offline harness accepts them as explicit input. Retain provenance using the hashes above.

## Empirical results (LibreOffice, independently from browser PDF output)

| Artifact | Sections | Explicit page breaks | Pages | Text blocks by page |
|---|---:|---:|---:|---|
| Rejected DOCX | 3 | 0 | 3 | 18, 21, 23 |
| Rejected browser PDF | — | — | 3 | 18, 21, 22 |
| Same DOCX, intermediate section properties removed | 1 | 0 | 3 | 29, 31, 2 |
| Same DOCX, intermediate sections removed and bounded compact XML spacing/margins | 1 | 0 | **2** | 27, 21 |

Original browser PDF page 1/2/3 vertical occupied extents: 470.3 / 437.5 / 478.0 points within 792-point physical page. PDF trailing white-space below last visible text: 266.9 / 306.7 / 266.2 points. These are **not** percentages of the text frame; they are measured physical page coordinates. Compact natural reflow page 1/2 occupied extents: 672.6 / 450.9 points. Shorter final page is not automatically a defect.

Original/compact DOCX text concatenation hashes identical: `04fe247529fa942ec2a541c26ccd7103b2b3a19e8b94ee312bb9712bccd41f20`. Both have 6,149 direct text characters and minimum explicit run size 22 half-points (=11pt). The experiment did not alter text or direct run font sizes. It DID change 36pt margins, line spacing to 240 twips, paragraph before/after gaps; therefore it is **not** a test of section removal alone. It is a constructive two-page feasibility demonstration under approved 11-point minimum, subject to user approval of the compact layout.

## Source code causal chain
1. `lib/documents/generate.ts`: `paginate()` partitions blocks according to element heights and a target-page squared-error score, with no cost for wasted section-end space beyond balancing; `generateDocx()` maps `layout.pages` to `Document.sections`. This couples the inferred partition to hard Word section boundaries and suppresses natural reflow.
2. `lib/documents/render.ts`: docx-preview renders each Word section as `section.docx`; injected CSS imposes `break-after:page`, ensuring calculated sections become explicit browser PDF page boundaries. Measurement is an intra-section block height check, not an independent document-wide layout optimization.
3. `lib/documents/production.ts`: after successful mechanical inspection, `lastValid` may be returned when visual critique is blocked, fails, is nonactionable, or its revisions cannot be applied. This is deliberate PR #983 behavior, not evidence of a technical delivery breach; it allows unresolved professional design findings.
4. `lib/documents/design.ts`: permitted intents are section-separation, list-rhythm, line-rhythm, heading-hierarchy, page-balance; actual adjustments only *increase* existing section/list/line/hierarchy scalars within ceilings. It has no controlled ability to remove unnecessary pagination boundaries or reduce excess spacing to approved compact bounds.
5. `lib/documents/model.ts`: parsing recognizes headings/paragraphs/bullets/tables, but does not encode engagement-with-accomplishments grouping beyond `keepNext` on heading and `keepLines` on paragraphs. This is insufficient for multi-paragraph bullet group continuity.

## Directly supported conclusions
- Forced section boundaries account for **substantial** extra whitespace: removing them moves nearly all content from third page into the first two, leaving 2 blocks on the third.
- Sections **alone** do not explain the entire third page: plain natural reflow remained 3 pages.
- Compact natural reflow shows 2 pages can be achieved at the original 11pt run-size floor with exactly identical source text; Word's own repagination and browser PDF parity still need separate qualification.
- Passing the existing mechanical validation does not establish professional appearance; PR #983 explicitly allows technical-only delivery.

## Requirements for correction (not implemented)
- Separate semantic grouping and page constraints from optional page segmentation; allow controlled natural reflow and stable DOCX / browser PDF parity.
- Use rendered geometry, not only estimated block sums, to detect or justify section transitions.
- Preserve atomic or preferred groupings for engagement headings and their first substantive accomplishment, and cohesive bullets where physically possible; provide observable failures.
- Permit bounded compactness and whitespace redistribution within approved 11pt minimum and immutable content, including decreasing excessive gaps where warranted.
- Enforce explicit acceptance states: mechanically valid; design accepted; design unresolved; authorized for delivery. Do not label the latter two interchangeably.
- Persist reviewer evidence, rendered page images, measured geometry, and independent cross-render consistency.
- Protect auth, user-approved content, glyph order, financial controls, page-count constraints, and bounded reviews.

## Acceptance contract (proposed)
- **Hard fails:** wrong requested page count, nonmatching ordered source glyphs, sub-11pt body, unauthorized content changes, invalid/unauthorized files or download, clipped/overlapping text beyond measured tolerances, unexpected section break producing a stranded header, Word-versus-PDF page-count mismatch where both must match.
- **Visual inspect:** each final page for hierarchy, engagement continuity, rhythm, gutters, severe unused space; compare every revision. Do not apply a universal whitespace ratio; flag short pages only when an alternative valid layout removes a preventable break.
- **Regression fixtures:** actual rejected résumé, financial report with grouped tables/footnotes, agreement with numbered clauses and signatures. Each must be rendered through Katie's engine and LibreOffice, then inspected, not merely parsed.
- Record one and only one clear delivery status: design pass, unresolved design disclosed, or no delivery under strict user requirement.

## Phase 2 dependency-ordered proposal (not authorized)
1. Preserve source and approval contracts; introduce semantic grouping metadata, without templates.
2. Fix pagination mechanics with real-render feedback and conditional soft page boundaries.
3. Add approved compactability controls, explicit comparison logic, and cross-render safeguards.
4. Extend visual reviewer actions to act on detected white-space and continuity defects.
5. Run offline multi-document render tests, independent visual acceptance, then production qualification in Phase 3.

## Open gaps / not completed
- Harness added for original résumé, but actual private fixture bytes remain external; CI cannot reproduce without owner-supplied fixture in a secure artifact store.
- Financial report and business agreement fixture generators and tests still needed.
- Actual-height vs estimated-height per-block calibration not measured.
- Complete request-through-final-delivery runtime trace, browser-vs-LibreOffice glyph parity, and live production deployment verification not performed.
- Independent Word (Microsoft Word, rather than LibreOffice) render not available.
- Exact engineering regression harness invocation on this branch has not yet been independently executed in CI.
- No universal design-quality automation has been established.

**Phase 1: FAIL / incomplete** under the owner's stated gate. No production functionality changed; no paid inference, deployment or DB changes.
