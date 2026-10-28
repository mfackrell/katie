# Standalone API cost controls

Standalone inference is admitted by PostgreSQL immediately before each actual provider transmission. Ordinary chat, helpers, reviews, routing, attachment processing, and memory work share the original authenticated request's ledger. Developer Orchestrator and benchmark budgets retain their existing separate accounting.

## Configuration and release

No dollar thresholds or timezone were supplied for this implementation. No values are seeded. Unconfigured accounts cannot dispatch paid requests.

1. Review the additive migration `supabase/migrations/20261028193000_standalone_provider_attempt_ledger.sql`. Production's only migration writer remains `.github/workflows/migrate.yml` → `scripts/run-migrations.mjs`; see `docs/migration-authority.md`. Do not apply this migration through a second writer.
2. Provision verified Auth owner/standalone actor/conversation associations through the service-only `standalone_bind_scope(owner_uuid, actor_uuid, chat_uuid)` RPC. This administrative enrollment is deliberately absent from browser endpoints. Validate the owner against the Auth account before provisioning. Each conversation has one owner; saved actor/chat associations and standalone status are checked again at admission and dispatch.
3. Sign in with that owner account. Open Usage → Settings in the standalone conversation. Explicitly enter the per-call USD threshold, cumulative original-request USD threshold, and IANA daily reset timezone. Both thresholds and timezone are required. Dollar inputs accept up to six decimal places. They are thresholds for approval, not guaranteed invoice caps.
4. Review the call-path inventory and supported immutable price snapshot before enabling user traffic. Unsupported billing dimensions visibly stop before transmission. No automatic fallback bypass is provided. A provider-resolved model must also have an exact reviewed price; an unreviewed dated response model keeps known tokens visible and cost uncertain until supported reconciliation.
5. Run the offline CI gate and isolated database/browser tests described in the verification report. Paid live verification requires separate owner approval and an explicit spending cap.

Existing public/publishable Supabase configuration and server service credentials are used. No provider key is sent to the browser. Service-role access is restricted to owner-scoped RPCs for these accounting tables; direct table mutations and public/authenticated RPC execution are revoked.

## Estimates and authority

The exact prepared JSON body, model, provider, endpoint, image bytes/detail, tools, output allowance, immutable pricing version, estimator version, reason, and estimate are persisted before dispatch. The actual transmitted canonical bytes are derived from this frozen value. Unknown pricing, unsupported content, authentication failure, accounting outage, stale approval, changed payload, or unresolved prior transmission cannot authorize another paid call.

All monetary values are integer micro-USD (`numeric(30,0)` in PostgreSQL, decimal strings over JSON, `bigint` in application calculations). Rates use integer nano-USD per token. The full token-cost calculation rounds upward once to the next micro-USD. Input byte/token and image allowances are estimates; the UI discloses assumptions. Reservations are estimated exposure, not a contractual dollar ceiling. Provider invoices remain authoritative for final billing. Explicit Claude five-minute cache breakpoints reserve the whole estimated input at the five-minute write rate without assuming cache hits. Receipts price disjoint uncached, read and write tokens; unsupported or unproved write lifetimes retain known usage and uncertain exposure.

An approval authorizes one frozen attempt for its displayed reservation. It does not increase the original request's automatic threshold, authorize another helper/retry, or permit a new payload. Database row locks serialize reservations and approval claims. Changes to configuration invalidate outstanding dispatch authority. Request-wide cancellation prevents future admission and attempts to abort active transports. Cancellation cannot establish that a provider stopped billing.

Reduce cost stores a linked revision, retaining the original prepared evidence. It removes redundant/older context or images, lowers supported image detail/output allowances, discloses tradeoffs, and creates a newly estimated proposal. Native tool chains are preserved. Approval of the original is never transferred.

## Durable execution and uncertainty

Original input, execution lease, initial context, stable message identities, provider HTTP responses, and execution checkpoints are durable. Resume loads server-saved original input rather than accepting a replacement message. Completed transmissions replay their saved responses; unresolved transmissions cannot be sent again. Per-activity attempt counters keep independent preprocessing and memory checkpoints stable. A regenerated payload mismatch blocks visibly.

Provider responses, including SSE, are buffered until a complete response and usage evidence are saved. This delays token-by-token streaming. Standalone memory processing uses durable inline checkpoints so a paused background charge remains resumable under the original request; managed-agent memory behavior retains its existing `after()` scheduling.

Timeout, incomplete stream, missing usage, cancellation after transmission, response capture failure, or reconciliation failure retains uncertain exposure. Only supported provider usage settles a transmission. Identical receipts settle idempotently; conflicting evidence is rejected and recorded. Known overruns are saved in full and stop further request admission. Append-only ledger events preserve reconciliation history without becoming a competing total.

For late reconciliation, use the service-only `standalone_settle` RPC with the exact owner, attempt, provider receipt identity, supported usage, immutable pricing calculation, and supporting evidence. Inspect saved provider identifiers/checkpoints first. Never infer zero charges from a timeout or cancellation, fabricate usage, reuse another attempt's receipt, or backfill provider dashboard category totals as per-call costs. Retain unresolved exposure if evidence is insufficient. No production reconciliation was performed by this change.

## Daily display

Usage is derived from ledger attempts, scoped to the verified owner and either this standalone agent or all standalone agents. Calls belong to their dispatch calendar day in the configured timezone. Calendar boundaries are calculated using IANA timezone rules, including daylight saving and midnight transitions. Pending/uncertain exposure from earlier days remains separately visible. Missing usage appears as unknown; it is never silently treated as zero. Model/activity detail includes paid hidden helpers. Requested/resolved models and saved estimation metadata remain distinguishable.

## Supported and blocked paths

See `standalone-call-path-coverage.md` and `standalone-pricing-evidence.md`. A configured provider or mutable model registry entry is not financial evidence. Unreviewed exact models, unsupported built-in paid tools, unsupported audio/video/native-file billing, image generation, Google file upload/storage, and RunPod submissions remain blocked. Existing objects can be read/polled where no new inference is initiated. Infrastructure storage/database/egress billing is not presented as token/model spending.

Implementation-agent billing receipts are not available in this environment. No development dollar-cost total is claimed. No live paid provider verification was authorized or performed.

## Rollback

Preserve all ledger, pricing, workflow, ownership, receipt, and event records. Do not drop tables, rewrite the migration, delete reservations, or release uncertain exposure. Roll back UI/estimator changes only behind the provider admission guard; do not deploy an older unguarded provider path. If a full application rollback would restore unguarded inference, disable paid dispatch at the provider credentials/access layer through an explicitly approved production configuration change before rollback. A failed migration/accounting lookup already fails closed.

## Production actions requiring Mark's separate approval

- Merge the PR and release/deploy application code.
- Execute the production migration through the established writer.
- Provision or change production owner bindings, thresholds, timezone, or credentials.
- Run any paid provider verification, with an explicit cap.

None of these production actions is part of implementation authorization.
