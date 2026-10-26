# PR #764 — acceptance and release decision

Review date: 2026-10-26. Branch `feat/unified-presentation-integration`.

## Source-level review (not independent sign-off)

| Area | Finding | Decision |
|---|---|---|
| Server validation | Strict versioned Zod envelope, bounded chart arrays, finite values, allowlisted properties. No executable component code or privileged action fields. | Promising; adversarial browser testing outstanding |
| Client trust | Streamed presentation is now revalidated against schema and must agree with canonical Markdown. | Static regression added; browser validation outstanding |
| Canonical answer | Earlier rendering replaced prose with visuals and could hide the answer. Corrected: existing Markdown always renders; supplementary non-Markdown blocks render after it. | Regression added; layout/order acceptance outstanding |
| Stream | Delimiter lookbehind buffers raw presentation JSON; server saves completed structured message before final content event. | Tests exist; cancellation, split UTF-8 and malformed marker/browser retry need live evidence |
| Persistence | Existing Supabase message JSON envelope stores validated presentation with text; legacy Markdown preserved, scoped replay loads saved message. | Unit roundtrip exists; authenticated refresh/reopen acceptance outstanding |
| Action boundary | Registry advertises only local expand/inspect; no privileged actions emitted by visual block schema. | Static review; full independent security review outstanding |
| Presentation fidelity | Renderer puts visuals after canonical prose; version 1 does not preserve arbitrary interleaving of rich and text blocks. Donut currently uses a list, not ring graphic. | Known feature gaps; do not claim universal presentation parity |
| Provider behavior | Single selected provider receives optional visual-generation instructions behind `KATIE_PRESENTATION_V1=enabled`; no extra formatting-model call. | Actual OpenAI, Google, Anthropic and Grok outputs not verified |
| Performance | Schema sizes bounded; no quantified latency, memory, network bytes, or incremental token usage. | Measurement outstanding |
| Accessibility | Native details, labelled chart SVG, fallback table and labelled statuses exist. | Keyboard/screen-reader and mobile browser acceptance outstanding |

## Acceptance test sequence still required

1. Review exact PR SHA against latest main, inspect merge conflicts, obtain separate independent security reviewer approval. No self-review counts as independent.
2. Deploy a non-production preview with the flag enabled only for approved disposable test actors and conversations. Never enable the presentation flag indiscriminately in production.
3. Use actual browser auth and test stream, refresh, reopen, mobile viewport, keyboard, screen reader, interrupted requests, retries, hostile payloads, and legacy messages. Compare the persisted response to the browser's final message.
4. With authorized inference budget, test actual model responses from each provider, capture model identity and response format failures, compare quality and cost/latency against a Markdown baseline. No fabricated model-acceptance claims.
5. Require all checks green at the final SHA; resolve review findings; only then consider merging. A production rollout requires an explicit approved decision and rollback plan (`KATIE_PRESENTATION_V1` off returns to Markdown).

## Release decision

**NO-GO.** An isolated feature gate protects production, but CI alone is not sufficient evidence for a new model-driven presentation system. No independent security sign-off or actual authenticated cross-provider browser acceptance has been produced in this review.
