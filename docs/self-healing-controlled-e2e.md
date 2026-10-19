# Controlled autonomous self-healing acceptance

This is a **synthetic failure-injection acceptance test** for Katie's **general-purpose recovery system**, not a game-specific test. It runs on every full CI gate and touches no production task, account, billing balance, database, or actual GitHub repository beyond committing the test itself.

## Execute
- `node --test tests/self-healing-controlled-e2e.test.mjs`: execute the **actual** `lib/recovery/worker.ts` supervisor in a TypeScript-transpiled, isolated test runtime with mocked GitHub/DB connectors. Simulates a verified infrastructure failure, a scoped specialist assignment, a draft repair PR, independent test/review, human owner merge, verified production release, original same-commit verification, and completion.
- `node --test tests/projects-sql.test.mjs`: uses an ephemeral local PostgreSQL instance, initializes real Supabase project/recovery SQL migrations, and runs `tests/fixtures/self-healing-controlled-e2e.sql` as a rollback-only transactional fixture. Tests admission, idempotency, actor/PR/SHA fencing, audit trail, token accounting and preservation of the original coding cycle.
- `npm run ci:gate`: the full repository regression suite, build and smoke; it discovers both tests automatically.

## Pass criteria (all mandatory)
1. A blocked approved project is discovered and claimed exactly once.
2. Trusted verifier evidence, not model/user-supplied assertions, classifies the error as infrastructure.
3. A scoped owner-authored repair issue is sent to the **existing** autonomous coding workflow. No privileged file paths are granted, no production write happens, and the original game/project stays blocked.
4. A proposed draft PR **alone** does not advance the case. Same-head independent tests and review must pass; a failed independent review must leave the case delegated.
5. Successful review changes the case to `awaiting_release`, with the original project still blocked. GitHub owner merge must occur separately.
6. A release is valid only if the **exact merged commit** is the verified production deployment. A merged PR without that verification must not restart work.
7. The original project resumes through its fenced service-role RPC on the unchanged original commit. Its scope approval, mission identity, spending and coding cycles remain unchanged.
8. `running` is **not** `completed`. Only independent completion of the original outcome resolves the recovery case. Duplicate recovery dispatches or resumes are rejected.
9. Stale project approvals and wrong actor/PR/SHA fail closed.

## Evidence boundaries
The JavaScript suite simulates GitHub's AI coding agent, its receipt artifact, merge, and production status. Its result proves Katie's **orchestration and permission boundaries** under controlled conditions, not that a live AI coding model will always find a successful patch. The PostgreSQL suite uses actual SQL inside a disposable instance but simulates the outside-world review/release signal. The whole system is considered live end-to-end proven only after an actual owner-approved, independently reviewed repair successfully returns a real blocked original project to completion.

No automated merges, secret changes, permission escalation, budget reset or bypass of original acceptance are introduced for testing.
