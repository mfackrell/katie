# Website review evidence

Website/marketing review requests with a public HTTP(S) URL now collect two forms of evidence in parallel:

- A web retrieval specialist returns source-grounded text and URLs.
- Chromium renders up to three pages at 1440×900 desktop and 390×844 mobile viewports. It captures HTML excerpts, linked stylesheet response bodies, computed styles and element positions, visible copy, image loading state, horizontal overflow and JPEG screenshots.

The first page can contribute up to two same-origin navigation/service/team/pricing links. Explicit URLs take priority. Follow-up reviews search all supplied user history, then an unambiguous single-domain conversation summary. Bare domains are normalized to HTTPS; assistant citations do not override the user target. Missing targets are reported explicitly without launching a browser.

## Shared handoff

The entire retrieval response is preserved in the shared research packet, outside the generic 12,000-character helper-answer limit. Lead control, independent critique, other helpers and replacement final synthesis receive that packet. Screenshot bytes travel as image inputs; their page/view mapping is in the text packet. The on-demand capability escalation path uses the same formatter and image handoff.

Claude now supports base64 or URL image blocks in both streaming and non-streaming requests.

Review instructions explicitly cover aesthetics and conversion: layout, typography, palette, spacing, imagery, hierarchy, navigation, responsive behavior and polish. Retrieved source content is untrusted data. Models must state incomplete coverage instead of inventing visual observations.

## Bounds and limitations

Browser capture runs once per turn, alongside retrieval, with a 45-second overall bound and short page/asset timeouts. Up to three pages, two viewports each, are sampled. HTML is limited to 12,000 characters per page and stylesheet excerpts to 8,000 characters per viewport. Computed style samples cover up to 32 visible elements per viewport. Screenshots cover at most the first 4,500 CSS pixels and 900 KB each. Excerpt/capture limits and failures are explicitly included in the packet. The full collected packet is delivered without downstream clipping.

Interactive menus, hover states, form submissions, authentication and pages beyond the sample are not tested. Blocked/late assets may limit coverage.

Only public HTTP(S) addresses with standard ports are permitted. Private IPs, unsafe schemes, embedded credentials, non-GET/HEAD requests, service workers and websockets are blocked. Requests and redirects are checked before browser navigation continues. The browser runs in fresh contexts without application credentials.

## Runtime and verification

Runtime dependencies are pinned: Chromium 148.0.0 and playwright-core 1.63.0. Node 22 is required. Next.js externalizes browser dependencies and explicitly includes the compressed Chromium binaries in chat/probe serverless bundles. No additional API key or browser service is required.

CI runs a real Chromium fixture test checking desktop/mobile CSS, HTML, stylesheets, screenshots and cleanup, alongside evidence-retention, model-handoff, image-adapter and URL-guard regression tests.

GET /api/health/website probes the deployed browser against the fixed https://example.com/ page using a follow-up request whose URL is eight history entries back. It returns target provenance, screenshot/view/style counts and coverage limitations, never image bytes or a user-controlled target.

Research trace events report complete response character count, target provenance, requested URLs, page/view/screenshot/stylesheet counts and bounded skip/failure/coverage reasons without logging screenshot bytes.

Run npm run test:website for strict compilation and focused website/provider/collaboration regression tests, including follow-up target recovery beyond six entries, summary recovery, absent-target diagnostics, real browser capture and complete evidence/image delivery. The general suite has 10 unrelated existing failures, verified against the prior production commit (11 before repairing its malformed protocol fixture); these are outside this change.
