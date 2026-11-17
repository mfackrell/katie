# Autonomous document delivery — quality contract

## Purpose
A technically valid file is not necessarily aesthetically polished. Delivery requires the user's hard constraints, semantic integrity, rendering and technical fidelity; independent professional-design review improves the candidate when possible but cannot veto delivery of mechanically accepted files.

This is a **general acceptance contract**, not a résumé template. It applies to résumés, financial reports, business proposals, letters, contracts, and other supported document types.

## 1. Source-of-truth and constraints
- Explicit current-turn constraints override earlier instructions. Clear continuations of the **same document** inherit its unsuperseded constraints, including requested page count and previously approved wording; unrelated documents never inherit them.
- Source selection must remain authorized and bound to the same conversation/task. A reference to “again” is not permission to choose or expose arbitrary old attachments.
- Never silently change facts, drop blocks, shrink below an approved font size, change the requested output type, or exceed an explicit page count to make a layout pass.
- If requirements cannot be met with safe layout alternatives, return a clear impossibility or clarification result rather than a falsely successful deliverable.

## 2. Document structure
- The canonical content representation must preserve the meaning of headings, subheadings, stand-alone labels, paragraphs, bullets, and tables, including relationships explicitly conveyed by Markdown.
- A title or label that introduces related detail must not be stranded at the bottom of a page with the detail beginning on the next page.
- Use semantic relationships instead of résumé-specific job-title lists or fixed styling recipes. Keep extracted/assistive-technology reading order consistent with the source.

## 3. Composition quality
- Inspect each actual rendered page for readable hierarchy, reasonable page balance, clipping, overlaps, broken tables, undesirable page starts/ends, and significant avoidable whitespace.
- Evaluate page balance in context. A short final page of an otherwise correctly composed legal document is not automatically defective; a gratuitous three-page result in place of an attainable two-page deliverable is.
- Cosmetic refinements are optional. Repeated inconsequential model suggestions must not cause endless re-rendering or expenditure.
- The same quality requirements must hold for the editable DOCX and delivered PDF.

## 4. Independent acceptance
- Mechanical acceptance: parseable DOCX and PDF; exact content survival; correct requested page count; verified PDF glyph order; authenticated delivery; rejection of unauthorized downloads.
- Structural acceptance: semantic groupings and reading order remain intact; any unavoidable aesthetic limitations are reported as presentation findings, not mistaken for lost content.
- Visual improvement: critique rasterized **final** pages when a qualified, authorized model is available. Compare revised images to the previous candidate; retain the last mechanically valid candidate if feedback is blocked, unavailable, invalid, unchanged, or regressed. A model PASS cannot override deterministic violations.
- Fail closed on a genuine technical defect, authorization/spending uncertainty, or unmet hard constraint. Do not fail document delivery solely because cosmetic revisions are unavailable or unsuccessful; do not treat successful CI alone as professional aesthetic quality evidence.

## 5. Release verification
1. Reproduce the actual failed artifact/requirement and identify which boundary was broken.
2. Demonstrate correction without rewriting content or weakening PDF/ATS/security checks.
3. Test the same mechanism against at least two materially different document structures (for example, a heading-and-bullets executive résumé, a narrative business report, and a tabular financial statement).
4. Verify DOCX with an office-compatible renderer and PDF using extracted text plus page images.
5. Document actual observed outcomes, remaining limitations, and whether any paid inference occurred.
6. Promote only the independently reviewed, exact qualified commit.

## Sources of general principles
- W3C WCAG 2.2, Info and Relationships: https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships.html
- W3C WCAG 2.2, Meaningful Sequence: https://www.w3.org/WAI/WCAG22/Understanding/meaningful-sequence
- Microsoft Word, Keep Text Together (heading/next and widow/orphan): https://support.microsoft.com/en-us/word/keep-text-together-in-word

No proprietary design palette, résumé-specific wording, or additional model/provider is mandated by this contract.
