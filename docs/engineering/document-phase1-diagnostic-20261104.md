# Katie document engine — Phase 1 root-cause and regression evidence

**Investigation date:** 2026-11-04. **Scope:** Diagnostic fixtures and CI only. **Production engine:** unchanged. **Paid model calls:** none. **Deployment:** none.

## 1. Proven conclusions, distinguished from inference

**Private production incident.** The rejected DOCX (SHA-256 `58b4d24d01783651e6ef4a9a5c9444f45822798fe9f19c8f6f178faa459d263f`) and PDF (`53c3d4e95fed0cacd311e544cb3b067eacc9c4076d4f081f781f3f0f1f737806`) render as **three pages** in both LibreOffice and Chromium. The DOCX contains **three section definitions** and **no explicit `w:br type=page` elements**. In Office, all three original pages have 437–483 pt of actual text span on 792-pt paper, followed by 250–308 pt of physical bottom blank space. Two engagement groups cross a forced boundary, one after only two of its related blocks.

**Controlled private-source counterfactual.** Removing intermediate Word section properties without changing text yields **three naturally reflowed pages**, with only two text blocks on the third. Removing the premature boundaries *and* enabling approved compact 11-point layout (36pt margins, 240-twip line spacing, bounded before/after gaps) yields **two pages** in LibreOffice. The original and compact direct XML text both contain 6,149 characters and have the identical SHA-256 `04fe247529fa942ec2a541c26ccd7103b2b3a19e8b94ee312bb9712bccd41f20`, with 22 half-point (11pt) minimum explicit run sizes. This **proves physical two-page feasibility for the private content under compact settings in LibreOffice**. It does **not** establish that the historical Katie production run selected those settings, that native Microsoft Word would produce two pages, or that the exact private source was regenerated through today's Katie runtime.

**Real-generator synthetic reproduction.** `tests/document-phase1-qualification.test.ts` invokes `generateDocx`, `renderDocument`, `produceDocument`, and `paginate` using synthetic executive résumé, financial report, and business agreement. It stores real DOCX, PDF and rendered PNG outputs; checks source text, glyph order, minimum font size, and required page count; and deliberately issues an offline blocked visual verdict. The real generator creates a three-section résumé when handed three page partitions; both Chromium and LibreOffice then render three pages, demonstrating the mechanism independently from OOXML surgery.

**Real-generator compact counterfactual.** The financial-report and business-agreement fixtures without explicit page limits each render **2 pages by default, but 1 page using Katie's existing 11-point compact layout**, both in Chromium and LibreOffice, with no mechanical inspection findings on the compact candidates. This directly proves the current engine can waste an entire page in more than one professional document type. The two-page-target résumé also fits one compact page, but one page would **violate its explicit two-page requirement**; that result is diagnostic only.

## 2. Actual block measurements and resulting page geometry

The generator does **not** invent block heights from a constant formula: `renderDocument` measures DOCX-preview DOM `getBoundingClientRect().height` plus computed vertical margins. `paginate()` treats those per-block measurements as additive and compares their sums with a single rectangular page-capacity estimate of **915.2 px** (standard layout). This simplification omits cross-block margin behavior, render-engine differences, group integrity, and the visual cost of forced boundaries. The measured DOM block sum versus PDF glyph-ink span is **not an error rate**: glyph bounds intentionally exclude paragraph leading, spacing and margins included by the DOM measurement.

| Real generator fixture | Initial measured DOM block sum | Standard estimated capacity | Formula min pages | Default final browser / Office | Compact natural browser / Office | DOM sum minus initial browser PDF text-ink span |
|---|---:|---:|---:|---|---|---:|
| Synthetic executive résumé (explicit 2 pages) | 1105.760 px | 915.2 px | 2 | 2 / 2 | 1 / 1 (not compliant with requested 2) | 84.347 px |
| Financial report (no page limit) | 1063.708 px | 915.2 px | 2 | 2 / 2 | **1 / 1** | 89.295 px |
| Business agreement (no page limit) | 1037.583 px | 915.2 px | 2 | 2 / 2 | **1 / 1** | 94.170 px |
| Deliberately imposed 3-section résumé | N/A | N/A | N/A | **3 / 3** | N/A | N/A |

**Physical office-PDF text spans, default generator:** résumé 387.12 / 385.68 pt on pages 1/2; financial report 365.92 / 375.98 pt; agreement 367.52 / 330.94 pt; forced 3-section résumé 223.12 / 284.88 / 257.73 pt. Actual page 792pt. These demonstrate the amount of unused space, but **no universal percentage threshold is valid** for professional acceptance. The stronger proof of avoidable pagination is the one-page, no-font-shrink, same-source counterfactual for the two non-page-limited fixtures.

All four final default/forced cases show **zero office-vs-browser page-count differences** in the focused CI run. Word-vs-browser pixel placement is not identical and was measured separately. Microsoft Word application rendering was unavailable.

## 3. End-to-end production trace and constraint loss

1. `app/api/chat/route.ts` starts `documentProduction = documentRequest(message)` (~line 757). A retry such as “give me the final resume in docx and pdf again” produces an empty production request **without `pages`**.
2. An explicitly selected saved message (`documentSourceMessageId`) may populate `selectedDocumentSource` (~line 773). Without this selection, model-authored document content may be used; approved wording is not inherently pinned simply because a retry says “again.”
3. Recent same-chat messages are loaded with `getRecentMessages(chatId,60)` (~line 846). The code may use a pending review task or task-progress objective, then `inheritDocumentPageConstraint(message,documentProduction,attachmentHistory)` (~line 1847). Inheritance requires a qualifying earlier *user* document request with an explicit count and a same-document topic. Merely quoting “two-page” in a résumé assessment is not a qualifying production instruction.
4. At final generation, the route passes `documentProduction.pages` to `deliverDocument` (~line 3716). `lib/documents/service.ts` calls `parseDocument(result.text,input.targetPages)` and then `produceDocument()`.
5. `lib/documents/model.ts` parses the Markdown into flat heading, paragraph, bullet, and table blocks. It carries no engagement-group semantic identity and no formal section-continuity graph.
6. `lib/documents/production.ts` first generates a single section, measures via `renderDocument`, and on mechanical problems chooses `pages = spec.targetPages ?? ceil(sum(actualBlockHeights)/capacity)`. The *compact* fallback is restricted to a **failed exact two-page fit** (`shouldTryCompactLayout`: `spec.targetPages === 2`).
7. `lib/documents/generate.ts` uses dynamic programming and squared deviation from equal target heights; it avoids ending a partition on a heading but otherwise permits splitting an engagement's following bullets. `generateDocx` maps each partition to a separate Word **section**.
8. `lib/documents/render.ts` calls docx-preview and explicitly styles each `section.docx` with `break-after:page`. Its mechanical whitespace finding only flags a page using **less than 25%** of its area or a blank page; material imbalance of 40–55% can therefore pass.
9. `lib/documents/design.ts` allows only `section-separation`, `list-rhythm`, `line-rhythm`, `heading-hierarchy`, and `page-balance`; corrections only increase spacing, line scale or hierarchy. **It cannot remove section boundaries, reduce excess spacing, change allowed page allocation, or keep multi-block engagement groups together.**
10. `lib/documents/production.ts` retains `lastValid` when optional design review is blocked, unavailable, invalid, or cannot safely improve a candidate. The result is explicitly labeled `technical-only`, but `lib/documents/service.ts` may still securely store and return files. This is an intentional #983 availability tradeoff, **not** a professional-design PASS.
11. Storage still controls authenticated save and readback, then the route emits the final download links. No authentication or financial code was changed in Phase 1.

**Historical two-page constraint finding.** The November 4 completed three-page delivery had a retry-only user request without an explicit count. Read-only inspection of same-chat user history did not find a qualifying explicit two-page generation request in the 60-message inheritance window. The current deterministic routing rules therefore explain why `pages` would remain absent. Moreover, a delivered **three-page** PDF cannot satisfy the hard `renderDocument` page-count check with `spec.targetPages=2` under the inspected production path: the intent did **not survive as an enforced two-page limit**. **Residual forensic limitation:** the precise historical `spec.targetPages` object was not persisted; we can rule out an enforced value of 2 from code and delivery behavior, but cannot quote a recorded runtime variable. Production logging should safely record requested vs inherited page-count provenance, without capturing private content.

## 4. Existing quality gate failures and their triggering conditions

| Defect | Trigger | Why current validation misses it |
|---|---|---|
| Extra/forced pages | inferred page count and DP-balanced partitions | sections become hard browser page breaks; no natural-reflow alternative comparison |
| Fragmented accomplishments | heading followed by multiple independent bullet blocks | heading `keepNext` only protects one following block |
| Excess blank space | default layout minimum-page formula selects 2 or 3 | clipping/page-count checks pass; whitespace rule only catches less than 25% of a page |
| Inadequate correction | reviewer asks for page balance and group cohesion | controls can only increase spacing/hierarchy; cannot compact or undo a break |
| Misleading practical delivery | visual review blocked or nonactionable | `lastValid` retained as mechanically valid `technical-only`; design not required for delivery |
| Lost inherited page count | “again” has no explicit count and history has no qualifying same-document request | `targetPages` remains unspecified; compact two-page fallback cannot activate |

## 5. Reproducible CI and private acceptance

- Focused offline workflow: `.github/workflows/document-phase1-diagnostics.yml`. It compiles existing TypeScript, runs the **actual generator and renderer** using synthetic fixtures, renders DOCX in LibreOffice, measures PDF word bounding boxes and semantic-group continuity, records pending visual-quality contracts, and uploads page-by-page PNG/DOCX/PDF evidence.
- Regression source: `tests/document-phase1-qualification.test.ts` and `scripts/document-phase1-word-acceptance.mjs`.
- Cross-render artifact measurements: `test-artifacts/documents/phase1/phase1-cross-render-report.json`.
- Private real-case fixture: `scripts/document_phase1_baseline.py /path/to/rejected.docx` runs offline and does not commit personal content. Provenance is pinned by the two private-file SHA-256 hashes above; private acceptance bytes must be supplied separately.
- Main `.github/workflows/ci.yml` includes the same Word/Chromium acceptance after dependency installation for eventual integration.
- `fixtures/documents/phase1-acceptance-contract.json` defines 11 measurable gates. Five are instrumented; **six professional-quality requirements are explicitly pending**. `scripts/document-phase1-contract.mjs --enforce-phase2` intentionally fails while those pending requirements remain. Do not reclassify a mechanically valid document as professionally accepted.

The tests are **diagnostic reproduction**: assertions on forced sections confirm the defect remains reproducible, **not that three pages is desirable**. The six pending professional requirements retain their full target quality criteria.

## 6. Required Phase 2 capabilities and acceptance contract

**Hard invariant:** source glyph fidelity, approved content and semantic table cells, no change in font floor, exact requested page count, safe reading order and Unicode, authenticated downloads, financial/provider admission, bounded iteration, no unrelated chat/workflow changes.

**Structural acceptance:** preserve engagement heading + employer/date + first substantive bullet; keep cohesive bullet groups when geometry allows; preserve numbered clauses, signature labels and table header/rows; document justified group splits; reject avoidable forced section breaks proven by an alternate same-text valid layout.

**Pagination:** distinguish requested pages from the preferred minimum number of pages; measure real page geometry and cross-render differences; compare bounded natural-reflow and compact candidates before emitting hard section/page boundaries. Never make a short page a defect solely because of its utilization ratio.

**Design review:** independent final-page raster inspection with actionable pagination/group/compactness controls, before/after comparison, explicit unresolved-design status, and no unsupported model-authored CSS. Professional-design acceptance must be distinct from technical validity and delivery permission.

**Release requirement:** each synthetic fixture **and the private acceptance résumé** must be rendered and inspected through the implemented production engine, LibreOffice and Chromium, with exact page caps and final Word/PDF geometry. Microsoft Word parity is desirable when available; if not, retain declared limitations and test coverage. Phase 3 may not claim full professional quality while any mandatory requirement remains pending.

## 7. Recommended Phase 2 implementation order — NOT STARTED

1. Preserve request/document identity, explicit page-count provenance and approved source text.
2. Add general semantic group constraints for headings, first supporting blocks, list groups, tables and clauses.
3. Separate *soft* page planning from *hard* page boundaries; introduce actual-render-informed reflow and cross-render checks.
4. Select bounded compactness versus spread based on page requirement and measured composition, without font shrink or wording changes.
5. Extend visual critique actions to express and execute the failures established here.
6. Require deterministic structural checks + independent visual acceptance before professional delivery; keep financial authorization, secure storage, Unicode and reading-order validation intact.
7. Run private plus synthetic regressions, independent Word/PDF visual comparison and final security qualification before any release.

## 8. Qualification verdict and remaining limits

**Phase 1 investigation and regression baseline: PASS** on the explicit exit criteria: reproduced real three-page failure; independently demonstrated two-page physical feasibility; confirmed forced section and non-actionable design controls; exercised real generator on résumé/report/agreement; proved compact 1-page counterfactual for report/agreement; ran actual browser and LibreOffice page inspection; recorded pending quality gates; preserved production code.

**The production document engine is NOT fixed and NOT professionally qualified.** The explicitly pending Phase 2 gates are not Phase 1 failures.

Remaining non-blocking scope: no captured literal historical `spec.targetPages` value, private résumé not rerun end-to-end inside Katie due private source isolation, and native Microsoft Word application parity not tested. These must be addressed in Phase 2/3 acceptance as specified rather than implied complete.

**No merge, deployment, paid model call, database mutation, or change to production document-generation behavior.**
