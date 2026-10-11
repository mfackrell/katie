# Visual review integration verification

Date: 2026-10-11. Integrated against Katie main `51cd8a13e58830494a43958d8453c29422e43998` on `codex/visual-review-integration`.

Story: a website review in Katie collects rendered tiles, gives the same evidence to its lead and critique, persists the private snapshot, and compares a subsequent fresh inspection without falsely claiming repairs.

## Plan and pressure test

1. Reuse Katie's browser, review-agent handoff, provider image adapters and private evidence store. Port the standalone measured review logic to typed TypeScript; avoid a second browser service or model client.
2. Replace first-4500px screenshots with bounded overlapping tiles. Keep HTML, CSS, computed style and legacy snapshot support.
3. Keep measured findings separate from subjective model opinions. Explicitly distinguish incomplete coverage from a clean result.
4. Connect fresh reviews to owned historical evidence. Require matching URL/view/state, unchanged target identity, complete captures and intact image hashes before marking a measured issue resolved.
5. Run real Chromium scenarios, Katie's existing provider/collaboration/storage regressions, build and local production HTTP probes. Do not deploy.

Pressure cases included below-fold defects, deletion and replacement masquerading as repairs, partial/missing views, corrupted screenshot hashes, fixed headers, fractional page-bottom coordinates, blank pages, missing assets, disclosure-state isolation, forbidden writes/forms, and a model reporting no issues despite a measured defect. The fractional-pixel test exposed a real boundary problem; a one-CSS-pixel tolerance fixed it.

## Results

| Boundary | Result | Evidence |
| --- | --- | --- |
| Scoped strict compilation + website suite | Pass | `npm run test:website`: 154 passed, 0 failed, 0 skipped. Seven new integration scenarios use real Chromium. |
| Updated required-review suite | Pass | `npm run test:review`: 43 passed, 0 failed. Includes the new upstream review-contract checks. |
| Capture → reviewer input | Pass | Actual tile images and measured findings reach the lead and independent critique; a model's empty/incorrect assessment does not erase them. Legacy provider image and replacement-synthesis tests also pass. |
| Separate-turn persistence → comparison | Pass with storage test double | Uses Katie's real store/formatter/comparator code with a deterministic private object-store fixture. Historical images stay separate; actor ownership is checked. No production Storage writes were made. |
| Production build | Pass | `npm run build` with placeholder Supabase values. Existing video-module createRequire warning remains. Production Storage postbuild probe correctly skipped outside a production deployment. |
| Built Next.js page | Pass | HTTP 200, 17,310 HTML characters via a local `next start -H 127.0.0.1`. |
| Built website health route, native workspace networking | Environment-limited | HTTP 503 correctly reports `getaddrinfo EAI_AGAIN example.com`; the workspace requires proxy networking. No fabricated success. |
| Built website health route, test-only proxy adapter | Pass | Real https://example.com/: HTTP 200, healthy true, target recovered from history, two views, three images. The adapter supplies public DNS-over-HTTPS and TLS-validated proxy transport; Katie's capture/rendering path is unchanged. Adapter is outside the repo and is not deployed. |
| General project typecheck | Pre-existing failures | `npm run typecheck` reports 24 errors; an untouched baseline worktree reports the exact same 24 errors. Focused strict compilation and Next build succeed. |
| Legacy URL check | Pass | `npm run check:url`. |

The stock runtime smoke command cannot enumerate this sandbox's network interfaces (`uv_interface_addresses`); explicitly binding loopback starts the same built app successfully. Node 24.19.0 was used. Runtime browser dependencies were installed from Katie's unchanged lockfile.

## Deployment boundary

No production merge, migration or deployment was performed. `vercel.json` disables automatic Git deployments for this specific integration branch, leaving other branches unchanged. Before any deployment is treated as verified, run the native health probe in the actual target environment and perform a live authenticated chat/Storage round trip there. This session verified the local Katie code paths, production bundle, real browser behavior and provider contracts; it did not assert that production credentials or native outbound networking were exercised.

The existing network validator is retained, not promoted to a hardened egress boundary. DNS pinning and comprehensive hostile-origin isolation are not added by this integration. Subjective design accuracy is not guaranteed by measured checks or stubbed provider contract tests.
