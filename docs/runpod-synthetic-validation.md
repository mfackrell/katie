# WP4 synthetic validation — draft PR / operator runbook

Draft title: Add authenticated one-shot synthetic RunPod pipeline validation.

This change reserves an isolated actor, chat and assistant placeholder atomically, uploads a bundled two-second MP4, and calls the real `submitSavedVideo` path. The existing reconciliation and Grok cron workers deliver the final answer. No cron schedules, normal chat routing, existing migration, or orchestration workflow is changed. The fixture shows a white square on red for one second, then the same square on blue for one second; it contains no people or user media. SHA-256: `42cc3d66eaa3307822a034c05febeb34b4364278cf8f56a9ca1621d46a1f3803`.

## Release prerequisites (coordinator only)

1. Independently review this draft and run `npm run ci:gate` in an unrestricted disposable CI environment. Apply the new append-only `202610130005_runpod_synthetic_validation.sql` migration after checking deployed actors/chats/messages/chat_requests column types against the existing application persistence contract. The disposable PostgreSQL regression verifies setup, privileges, retry exclusion, cleanup and survival of unrelated records.
2. Release the application and updated proof-authenticated webhook source through the normal approved process. The webhook adds provenance only for `synthetic-wp4`; it never returns callback proof, signed source URLs or input. A webhook without this change can deliver the result but cannot yield LIVE PASS. Existing normal-job semantics stay the same.
3. Confirm private attachment storage, existing minute cron schedules, RunPod endpoint `yafwsm98e8m9lv`, frame-extraction binary, Grok credentials, and conversational provider are configured. No legacy QA function is reactivated. Keep the harness flag absent or false on normal deployments.
4. In the authorized operator window set `RUNPOD_SYNTHETIC_VALIDATION_ENABLED=true` on the server. Authentication uses the existing `x-runpod-admin-token` control with a token of at least 32 characters. Never put tokens in query strings, source files, shell command arguments or logs. Server body parameters cannot select an actor, source, prompt, endpoint or quantity.

## Cost and lifetime bounds

There is one permanent `wp4` claim per database. Retried/concurrent POSTs return `already_claimed` and cannot upload or submit again, including after failure or cleanup. A crash after claiming consumes the opportunity; do not delete/reset the ledger to retry. Repeatability means repeating status/retry/cleanup checks for that one run, not authorizing new paid jobs.

The synthetic submission uses RunPod `policy.executionTimeout=60000` and `policy.ttl=900000`: one POST, at most 60 seconds of provider execution and 15 minutes of provider job lifetime including queue wait. The fixture has 24 frames at 320×240. Existing downstream Grok recovery retains its three-attempt cap and conversational synthesis order. These are workload caps, not a dollar guarantee: the operator must confirm current endpoint billing and set the provider/account spending limit before enabling the test. This implementation cannot enforce the provider's external billing contract.

The validation deadline is 20 minutes from the database claim. The operator tool polls read-only every 15 seconds and cleans up at the deadline. Keep that process running. If it stops or loses access, resume status and explicitly clean up after the deadline; the application does not introduce a recurring cleanup/GPU task. Existing cron processing can continue until cleanup, within its existing retry limits. Cleanup stops future scans by deleting only the ledger-owned job, request, messages, chat and actor, plus the exact synthetic `.source` and `.json` storage objects. The permanent ledger remains. An already-running provider/cron invocation is not cancelled by deletion; the provider policy bounds GPU execution and deleted records prevent subsequent delivery.

## Operator commands

Use a trusted operator environment with `KATIE_OPERATOR_ORIGIN` set to the application's HTTPS origin and `RUNPOD_INTERNAL_TOKEN` loaded securely into the environment. Do not run with real credentials in GitHub Actions or coding-agent CI. The following commands contain no secrets:

```sh
node scripts/runpod-synthetic-operator.mjs status
# After checking the account budget, set KATIE_SYNTHETIC_COST_APPROVED
# to one-post-60-gpu-seconds in the secure operator environment.
node scripts/runpod-synthetic-operator.mjs run
node scripts/runpod-synthetic-operator.mjs cleanup
```

`run` sends exactly one POST, then only GETs until DELETE at the deadline. On any failure it stops; never repeat a failed provider POST directly. An operator can safely repeat the harness POST because the permanent claim prevents a second charge. `cleanup` before the deadline fails closed. Disable the server flag after cleanup. Status requires the same token and flag; it returns no chat/actor identifiers, content, proof, signed URL or provider exception. Status downloads only the synthetic original to check its hash and reads only request-correlated jobs plus the isolated chat's messages.

Save a status response with `livePass:true` **before cleanup**. This requires one completed receipt, authenticated callback matching its receipt/provider IDs, original hash availability, completed Grok evidence, one delivered job, exactly the expected assistant message in the isolated chat, matching actor/chat/source correlation, and a final answer mentioning red before blue and the white square. This lexical check is conservative and not a semantic proof; review synthetic-only output in the isolated chat for scene order and accuracy. A queued POST, poll-only completion, generic failure answer, duplicate rows, wrong actor, missing original or missed deadline cannot produce LIVE PASS. Offline actor-isolation tests additionally exercise the existing delivery path; the harness checks its own isolated correlations, not every unrelated production record.

## Verification record

No production resources were accessed and no live provider submission was performed by the implementation agent. LIVE PASS is unverified until the release coordinator runs the authenticated operator check. Focused mocked regressions cover authorization/default-off, concurrent trigger exclusion, ambiguous acceptance and crashes, fixture corruption, callback proof/provider binding, poll-first races, delivery/evidence checks and sanitized observability. Disposable PostgreSQL verifies the new migration and isolated cleanup. See the implementation agent's final report for full gate results; independent review remains the orchestration workflow's responsibility. This file supplies the draft PR description and verification instructions; no remote PR was created, pushed, merged or deployed.

Implementation-environment results: `npm run typecheck` and `npm run build` passed; the bundled MP4 appears in the synthetic route's Next.js tracing manifest. Direct execution of the six focused test files passed 34 tests (synthetic harness 6, webhook 14, submission 8, reconciliation 3, linked recovery 2, disposable PostgreSQL contract 1). `npm run ci:gate` was attempted and failed because nested Node subprocess spawning reports `EPERM` in this sandbox. The independent URL check likewise failed spawning `/bin/sh` with `EPERM`. Runtime smoke was attempted; direct diagnosis confirmed `listen EPERM` when binding the local Next.js server. No application failure was observed in the focused checks, but the full gate and runtime smoke must be rerun by the workflow. `git diff --check` and operator-script syntax checks passed.
