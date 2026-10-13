# Submission recovery

Apply append-only migration 202610130002 before enabling this code. Existing
receipts are not backfilled; their original proofs and results remain intact.

A unique nullable submission key claims each new local request/video before any
POST. Durable requests scope the key to actor, request and video index; unlinked
requests scope it to source chat, private path and exact question. A retry reads
that receipt, never repeats the POST, and rejects changed correlation. Historical
receipts have no key and cannot be deduplicated retroactively. Unlinked identical
requests reuse their original receipt even after failure; a new question is a new
request. There is no verified remote exactly-once/idempotency guarantee in source.

Before POST, signing/credential failures are definite local failures. Explicit
client rejection (HTTP 400/401/403/404/422/429) is recorded separately. Transport
errors, server errors and success without a valid ID remain acceptance-unknown.
Known IDs are retained for polling when a registration write can be recovered.
Recovery write/read failures are surfaced; the original pending receipt survives
and the authenticated callback still has its original proof. No input URL or
callback proof is persisted in error metadata.

Unknown pending work receives the same existing 15-minute Qwen budget as known
jobs, measured from receipt creation. After that local deadline it is marked
`timed_out` with `SUBMISSION_ACCEPTANCE_UNRESOLVED_DEADLINE`, explicitly recording
uncertainty rather than provider failure. This starts existing Grok recovery and
removes unresolved work from the active scan. It does not cancel remote work.
A proof-authenticated late callback may replace local deadline results, including
known-ID local deadlines and local 404 expiration, but cannot overwrite a provider-terminal result. Writes
compare the observed state, deadline code and provider identity to prevent stale
callback or poll cleanup from overwriting a concurrent terminal result. A late
result does not reset Grok leases or redeliver an already delivered response.
No remote ID can be discovered safely from an ambiguous POST in current source;
recovery of an unknown ID relies on the original callback. No blind resubmission
is performed, including after a deadline.

Rollout requires explicit deployment of the Supabase Edge Function; application
release automation does not deploy `supabase/functions`. Apply the new migration
first, then deploy `katie-runpod-result-webhook` with the repository configuration
(`verify_jwt = false`, receipt proof authentication retained), then release the
application. The webhook remains compatible with historical receipts and old
application callbacks. Confirm that the deployed webhook accepts authenticated
local-deadline recovery before enabling submission recovery in the application.
Do not edit previously applied migrations: this PR adds only the nullable column
and partial unique index; historical NULL keys remain outside the unique index.
Index creation takes a database lock, so schedule the migration appropriately.
