# Shared document production

Katie can produce Word and matching PDF files for explicit document-creation requests, including a requested page count. Standard actors and authorized managed specialist tasks share the same capability. The executive workflow can delegate document work to those tasks; the service does not grant a developer worker new user-document access.

## Execution

1. The lightweight intent module recognizes a current document request, or an answer bound to that document task. Ordinary text chat does not import the renderer.
2. The selected provider drafts content using the existing conversation evidence. Existing required content review runs before production. Failed review blocks file delivery.
3. `model.ts` accepts a bounded text grammar: headings, paragraphs, bullets and simple rectangular tables. It rejects executable/remote layouts. Content is not rewritten during formatting repair.
4. `generate.ts` creates genuine OOXML using pinned `docx`. Body type remains 11 points. Page breaks are explicit sections. The paginator measures the rendered blocks and balances contiguous pages without separating a heading from its next block.
5. `render.ts` opens those actual DOCX bytes with pinned `docx-preview` in Katie's existing Chromium runtime. It prints a tagged PDF, then opens that PDF with pinned PDF.js and rasterizes every page. Geometry, ink, page count and extracted reading order are checked. Arimo regular/bold fonts are locally bundled to make rendering deterministic; no remote fonts, URLs, scripts or document resources are allowed.
6. The selected provider receives the actual PDF page images for visual assessment of clipping, overlap, typography, spacing, page balance and tables. Every page requires an explicit result. Missing or malformed review is a failure, not approval.
7. At most three corrections adjust spacing or move unchanged content between pages, followed by regeneration, rendering and inspection. Unsupported defects or content that cannot fit at readable size produce a blocker, not smaller type or omitted facts.
8. Only accepted artifacts enter private storage. Uploads are read back and SHA-256 checked before a receipt is committed. Downloads authenticate the existing owner/guest session and enforce owner, actor and conversation scope, MIME, size and hash.

## Runtime and cost controls

The production path uses Node, Chromium and locally bundled JS/fonts. It does not depend on a system LibreOffice installation or an external conversion vendor. Maximum input is 180 blocks / 45,000 serialized characters, eight pages, 2 MB DOCX, 8 MB PDF and 12 MB total raster data. The browser is closed at the 120-second document deadline or the earlier chat deadline.

Drafting uses the existing provider/accounting path. Visual review uses `runWithStandaloneActivity` and the same selected provider/model; no unaccounted client, alternate model, changed spending threshold or automatic paid retry is introduced. Approval errors propagate to the original workflow. A completed delivery receipt is checkpointed; both stored artifacts are verified again before resumed publication. Rendering uses existing server compute and storage, with no additional per-document vendor billing. Those platform resource costs are not falsely recorded as zero-dollar provider inference.

Private files and receipts live as flat objects under `katie-attachments/chats/{chatId}`. They follow existing conversation retention and deletion; the temporary incoming-upload expiry does not apply. URLs point to authenticated `/api/documents/download`, never a public object or bearer-only storage link. Private document content is not written to application logs.

## Qualification

`tests/document-production.test.ts` exercises actual files and actual PDF page images. The fixed synthetic executive resume starts with all content on one page, forcing a detected overflow and a real repair. Corrected images must exactly match independently visually reviewed raster fingerprints, so the nonbillable fixture test cannot rubber-stamp arbitrary rendering. Tests verify DOCX extraction, PDF words/reading order, two pages, simple tables, missing inspection failure, unreadable page limits, upload failure, private storage, idempotent receipt reuse, actual HTTP download hashes, unauthenticated rejection and cross-actor/conversation rejection.

`scripts/document-word-acceptance.mjs` separately opens the final DOCX in LibreOffice, confirms exactly two pages and complete logical text, and renders page PNGs. CI uploads Word/PDF/page images and the inspection receipt.

Authenticated `POST /api/documents/qualification` accepts only an authorized `actorId` and `chatId`. It runs the same fixed synthetic fixture with zero inference calls, checks the reviewed raster fingerprints, stores private artifacts and returns download links and synthetic page previews. It cannot accept arbitrary document contents or bypass visual review for ordinary work. This is an operational qualification endpoint, not a replacement for production model-based visual inspection.

## Limits

This is a constrained document producer, not an arbitrary DOCX editor or full Word layout engine. It supports straightforward professional resumes, reports and similar documents. Arbitrary imported DOCX layouts, macros, embedded media, headers/footers, merged/nested tables and text boxes are not accepted. Word may substitute locally installed fonts; the deterministic fixture is additionally verified in a standard office application. Exact pagination of every document in every Word version is not guaranteed. A visual-model pass is an evidence-backed quality assessment, not a mathematical proof of all aesthetic properties.
