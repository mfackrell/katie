# Katie workspace redesign

Implements the 20 October 2026 UI review around five destinations: Home, Conversations, Work, Specialists, and Settings.

## Routes and compatibility

- `/` is Home; `/conversations/:id` loads the exact server-owned chat. Missing IDs never substitute a remembered conversation.
- `/work/:sourceType%3AsourceId` identifies projects, missions, and tasks without title matching. Project missions and their coding tasks are nested.
- `/specialists/:id` describes saved personas and accepted Executive capabilities; managed workers and possible QA identities are excluded from ordinary navigation.
- `/search` searches permitted conversation content, current work results, and specialist descriptions. Current bounds are explicitly reported: 2,000 messages and 500 records per work source.
- Old `/agents?mission=` and `/agents?task=` links resolve to the original scoped controls in `/settings/advanced`. Unlinked legacy missions remain available there.
- `/legacy` preserves the prior interface. Set `KATIE_WORKSPACE_UI=legacy` to restore it at the root. This flag does not alter execution.

## Continuity and data

`workspace_presentation_state` is a separate, RLS-enabled, service-only table. It stores scoped drafts, repository preferences, notes, read markers, pins, archives, and identity descriptions. Version checks reject stale writes. UI archive/hide never disables execution or deletes actors, memory, snapshots, or records. Unknown provenance remains unknown; QA names are suggestions, not verified classification.

Draft text is saved locally immediately and to the server after a short debounce. Pending binary attachments are scoped to the conversation in browser IndexedDB; they remain browser-local. Notes and repository preferences are server-owned. Pending requests, execution admission, scope approval, delivery IDs, review, and recovery retain their existing backend contracts.

The Work read model performs no reconciliation or execution on GET. A completed execution is not sufficient for “Result ready”: linked delivery receipts are checked. Review, delivery, execution, and read metadata remain separate. Source failures produce warnings while independent areas remain usable.

The Context panel shows repository scope and saved specialist memory; corrections are composed in the same conversation. It does not claim every saved record was used in a particular response or broaden actor memory sharing.

## Validation

- `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run check:url`.
- `node --test tests/workspace-api.test.mjs tests/workspace-presentation.test.mjs tests/homepage-mission-approvals.test.mjs tests/agent-management-browser.test.mjs tests/missions-browser.test.mjs`.
- `KATIE_UI_START_SERVER=1 KATIE_UI_SERVER_MODE=start node scripts/workspace-ui-acceptance.mjs` runs real Chromium against the built application with deterministic local fixture APIs. It covers Home, filtering, canonical routes, navigation and reload with an unsent draft, original discussion return, results, specialist discovery, error states, mobile navigation, keyboard dismissal, overflow, and zero accidental execution.
- The workspace browser acceptance is also run in CI after the strict build gate.
- The new migration was applied and verified with a rolled-back save/conflict transaction. RLS and public-role denial were checked directly. The security advisor's no-policy informational finding is intentional: this table follows the application's server-only access model.

The first local full regression run passed 1,209 Node tests in successful files plus seven Vitest checks. Thirteen files could not pass in this container, principally due to absent PostgreSQL 16, the initial incomplete Chromium runtime, and namespace/integration restrictions. These are not represented as passing; the normal CI gate remains required.

## Boundaries

The redesign does not merge duplicate-looking workers, share private memory, authorize new paid work while navigating, or treat a draft PR as deployed software. Large-scale indexing, immutable historical result versioning, physical-device usability studies, and a new cross-persona memory-sharing policy are outside this presentation change. Existing saved source and review records remain inspectable.

## Release

Publication and deployment proceed after the complete CI gate passes. The additive presentation-state migration is applied and verified. The legacy interface remains available for rollback.
