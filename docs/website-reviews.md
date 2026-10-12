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

Browser capture runs once per turn, alongside retrieval, with a 45-second overall bound and short page/asset timeouts. Up to three pages, two viewports each, are sampled. HTML is limited to 12,000 characters per page and stylesheet excerpts to 8,000 characters per viewport. Computed style samples cover up to 32 visible elements per viewport. Screenshots are overlapping viewport tiles, up to 24 base tiles and 10 targeted occlusion checks per view, within a shared 60-frame / 6 MB image budget per inspection. Each image is at most 900 KB. The 45-second turn deadline takes priority over full-page coverage. Excerpt/capture limits and failures are explicitly included in the packet. The full collected packet is delivered without downstream clipping.

By default only the initial state is tested. Server-side callers can explicitly supply up to three named disclosure states with selectors and an optional expected visible target. Each state uses a fresh browser context and permits only a unique non-form button with aria-expanded/aria-controls; state navigation and write requests are blocked. No automatic menu discovery, hover testing, form submission or authentication is performed. Blocked/late assets may limit coverage.

Only public HTTP(S) addresses with standard ports are permitted. Private IPs, unsafe schemes, embedded credentials, non-GET/HEAD requests, service workers and websockets are blocked. The existing URL-validation path is retained. It is not a DNS-pinned egress proxy: do not treat it as a complete security boundary against adversarial hosts, DNS rebinding or browser redirect behavior. The browser runs in fresh contexts without application credentials.

## Runtime and verification

Runtime dependencies are pinned: Chromium 148.0.0 and playwright-core 1.63.0. The package declares Node 22; the integration was also tested on Node 24.19.0, matching the project runtime family. Next.js externalizes browser dependencies and explicitly includes the compressed Chromium binaries in chat/probe serverless bundles. No additional API key or browser service is required.

CI runs a real Chromium fixture test checking desktop/mobile CSS, HTML, stylesheets, screenshots and cleanup, alongside evidence-retention, model-handoff, image-adapter and URL-guard regression tests.

GET /api/health/website probes the deployed browser against the fixed https://example.com/ page using a follow-up request whose URL is eight history entries back. It requires complete visual coverage in both views and returns target provenance, screenshot/view/style/finding counts and coverage limitations, never image bytes or a user-controlled target.

Research trace events report complete response character count, target provenance, requested URLs, page/view/screenshot/stylesheet counts and bounded skip/failure/coverage reasons without logging screenshot bytes.

Run npm run test:website for strict compilation and focused website/provider/collaboration regression tests, including follow-up target recovery beyond six entries, summary recovery, absent-target diagnostics, real browser capture and complete evidence/image delivery.

## Measured review and repair checks

The review packet includes viewport-relative element bounds, stable selectors, screenshot SHA-256 hashes and independent measured findings for horizontal overflow, clipped content, failed image decoding and controls covered at three hit-test points. Intentional ellipsis, line clamping and scrolling containers are not reported as clipped text. Covered controls are centered and retested to remove fixed-header scroll artifacts. One CSS pixel of edge tolerance accommodates fractional layout coordinates at the page bottom.

Two successive screenshots must match. Blank captures, more than 500 candidate elements, failed assets, unstable frames, exhausted budgets and unfinished coverage are explicitly partial. Findings remain available on partial captures; successful repair certification does not. Measurements describe the captured state, not exhaustive accessibility or functional testing.

Fresh reviews load the prior private, actor/chat-owned snapshot on the server. Historical images are not passed as current images. The resulting comparison matches exact URL, device, viewport and named state, verifies screenshot integrity, and compares measured rules. A repair is resolved only when both views are complete, the same visible selector/tag/text remains, and its old measured rule no longer fires. Deleted, hidden, replaced, missing, corrupt or incomplete targets remain unverified or explicitly changed/missing. Older saved packets without visual-review metadata still render through the legacy image path and cannot certify repairs.

Katie's existing multimodal lead/critique/providers perform subjective review using the objective, actual tile images and measured packet. They must preserve the user's positioning and treat aesthetic suggestions as hypotheses. Their misses cannot remove measured findings. No second xAI client, Python transport, new API key, database migration or image-generation service is added to production. Standalone CLI/report/pixel-diff utilities remain standalone; they are not needed by Katie's chat flow. The integration keeps Katie's single overall deadline rather than adding the lab's per-view retries.

See [visual-review-integration-verification.md](visual-review-integration-verification.md) for the integration test evidence and remaining environment limits.
