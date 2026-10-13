# Draft PR: temporary authenticated WP4 synthetic cron

The temporary `/api/internal/runpod-results/synthetic-cron` GET route lets the existing trusted Vercel cron run the authorized one-shot synthetic test without exposing operator credentials. It requires both existing `assertCronAuth` authentication and `RUNPOD_SYNTHETIC_VALIDATION_ENABLED=true`; its schedule is once per minute. No caller can select media, actors, or submission parameters.

The route reads the existing synthetic status, starts only when no claim exists, and relies on the permanent database singleton for concurrent invocation exclusion. Failed or cleaned claims never authorize another provider POST. All status reads and cleanup use the existing isolated synthetic helpers. There are no core RunPod, main chat, workflow, or migration changes.

Each active tick logs only allowlisted callback, provider, fallback and delivery statuses plus `livePass`. Unknown provider strings are redacted. IDs, content, URLs, credentials, callback proofs and raw exceptions are never logged or returned by this route. A pre-cleanup observation is logged separately from the cleanup event; cleanup does not replace its `livePass` field. Logs are the durable evidence: save the original observation with `livePass:true` before cleanup, rather than querying the cleaned helper and treating its false result as a failed original run. No pass is inferred from submission or cleanup. The existing helper requires authenticated matching callback evidence and completion before the deadline.

At 20 minutes from claim, including when the helper still reports `pipeline_pass`, the cron invokes the existing cleanup helper. Failed cleanup is retried on subsequent ticks; cleaned ticks do no setup or cleanup. The claim remains permanent. A crash after claim consumes the one-shot opportunity. Concurrent cleanup calls use the existing idempotent storage deletion and database cleanup contract.

## Coordinator release and removal

1. Independently test and review this draft. Deploy only through the controlled coordinator workflow, with the existing synthetic migration already applied and existing callback v4 and cron credentials configured. The implementation agent does not deploy or access production resources.
2. The coordinator enables `RUNPOD_SYNTHETIC_VALIDATION_ENABLED=true` only after controlled deployment. The user already authorized the single billable synthetic test. Do not reset or remove the permanent claim.
3. Retain the sanitized pre-cleanup PASS observation or failure/deadline record and verify the cleanup event. Keep the flag enabled until cleanup succeeds; disabling it early also disables cron cleanup.
4. After the test and cleanup, disable/remove `RUNPOD_SYNTHETIC_VALIDATION_ENABLED`, delete `app/api/internal/runpod-results/synthetic-cron/route.ts`, and delete only its `/api/internal/runpod-results/synthetic-cron` entry from `vercel.json`. Remove the temporary cron regression test when removing the route. Preserve the permanent claim and all existing production crons.

Mocked regression tests cover denied/default-off access, concurrent singleton submission, pending and live pass observations, log redaction, deadline cleanup, failed cleanup retries, consumed claims after failure, and inert cleaned ticks. No tests make live provider calls. Validation and independent review results are reported by the implementation agent; this document supplies the draft PR content for the orchestration workflow, without pushing or creating a remote branch.

## Implementation validation

- Independent review: **PASS**, with seven cron tests independently rerun.
- Full `npm run typecheck`: **PASS**. `npm run build`: **PASS**, including production compilation and tracing.
- Direct focused mocked regressions: **40 passed**, no skipped tests (cron 7, synthetic helper 6, webhook 14, submission 8, reconciliation 3, linked recovery 2). No provider calls.
- `npm run ci:gate`: **BLOCKED** in this environment by nested test subprocess `spawnSync ... EPERM`; the workflow must rerun the complete gate. Separate `npm run check:url` also fails at `/bin/sh` subprocess spawning with `EPERM`. Separate runtime smoke fails when local Next.js startup exits before readiness; direct startup confirms `listen EPERM` on the local port. These checks are not reported as passes.
- `git diff --check`: **PASS**. No live validation, deployment, merge, push, remote PR creation or production access performed.
