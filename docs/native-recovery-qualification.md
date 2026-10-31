# Native execution recovery qualification (Deliverable C)

This qualification concerns Katie Builder recovery only. It neither resumes Take Eleven nor uses a real model provider. The code under test is the PR revision of the native host and recovery modules. The synthetic assignment uses the immutable benchmark baseline `0015bcdb8ac9ad94b7c74d1a4cd76737903b1319`, as required by the existing benchmark authorization RPCs, and changes only `app/pilot/` and `tests/native-recovery-synthetic.test.mjs` in a disposable repository.

## Reproduction and evidence

The `native-recovery-lifecycle` job in `.github/workflows/benchmark-gateway-qualification.yml` installs the pinned `@openai/codex-sdk@0.164.0`, PostgreSQL 16, bubblewrap and socat. It runs:

```sh
KATIE_TEST_NATIVE_RECOVERY_LIFECYCLE=1 node --test tests/benchmark-renewal-postgres.test.mjs
```

The ordinary renewal suite still runs its complete original assertions without that opt-in. The dedicated path reuses its disposable database setup and owner-renewal RPCs. Production credentials are absent. A test-only preload redirects the trusted host's provider and Supabase HTTP transports to a loopback server and rejects every other destination. The SDK and application sandbox never receive that preload or provider/database credentials. The PostgREST adapter returns database JSON types and calls the real migration RPCs as `service_role`; it does not return invented reservation or grant decisions.

The real `native-development-host.mjs` runs twice. It verifies signed handoffs, issues separate grants using existing RPCs, launches the actual sandboxed SDK child, uses the original scope gates, pushes completed and unverified checkpoints to a bare Git remote, authenticates diagnostics, restores source, and runs the existing deterministic/build/browser verifier. Synthetic SSE responses instruct actual SDK tools; this is execution-mechanics evidence, not real-model compliance evidence.

`native-recovery-qualification/report.json` and bounded host logs are uploaded even on failure. The report contains the task/project identities, frozen baseline, exact WIP ref and commit, completed checkpoint, SHA-256 file hashes, phase/request hashes, failure cases, accounting snapshot hashes, metered-review result, and actual browser acceptance report. A successful result requires the `NATIVE_RECOVERY_LIFECYCLE_PASS` marker; an artifact's existence alone does not mean the test passed.

## Lifecycle and safety assertions

1. A previously authorized synthetic task retains its historical calls, receipts and failed outcome. Authenticated evidence establishes that its earlier fixture attempt produced no source.
2. Actual implementation tools create two source files and an obsolete file. The host commits and pushes implementation. A separate read-only SDK process reviews that source and returns actionable findings.
3. Actual repair tools modify both existing source files, add a deterministic test, and delete the obsolete file. The next request is deliberately denied by admission. Before that denial, the actual HTTP bridge invokes durable WIP preservation. The host terminates without committing completed repair.
4. The entire candidate workspace is deleted. A fresh clone restores source from the remote checkpoint and trusted diagnostic artifact. All three file hashes and the deletion are checked, as are original review findings and the unverified state. PostgreSQL accounting/authorization snapshots must remain byte-for-byte equivalent.
5. A failed HEAD promotion during restoration leaves the original HEAD and remote WIP intact. Destroying that partial runner and restoring again must succeed.
6. A separately authorized successor uses the existing RPCs. Its real host independently discovers and restores WIP again, runs only repair and final review, and performs deterministic verification and Chromium acceptance. Exactly one recovered verification must pass at the final reviewed SHA.
7. Historical budget calls, mission calls, approval records, reservations and receipts remain unchanged. Only the separately authorized grant transition and new synthetic requests may be appended. Consumed and uncertain request identities cannot be replayed through real admission.

The negative tests cover task/project/baseline/scope/contract/provenance mismatches, corrupted metadata, out-of-scope trees, missing checkpoints, missing trusted artifacts, expired artifacts, unanchored concurrent checkpoints, missing/revoked/expired authority, duplicate requests and interrupted restoration. `tests/native-wip-recovery.test.mjs` additionally exercises superseded completed checkpoints, ref/worktree races, raw file materialization, and failure of deterministic/final-review acceptance. Full CI runs these tests independently of the hosted SDK scenario.

## Narrow runtime correction

An empty remote WIP ref list previously bypassed recovery entirely, even when the task recorded a failed execution. That could silently restart implementation after expected checkpoints disappeared. Failed tasks now require authenticated recovery evidence before grant issuance. A signed startup recovery retains its existing zero-historical-call exception. A pregrant recovery is not assumed to mean there is no earlier work.

A clean no-work result is accepted only when the authenticated artifact records exactly one clean final snapshot at the original baseline, no WIP failure, no review/repair/final-review or deterministic-verification evidence, and the host found no WIP refs. Missing artifacts are never interpreted as proof of no unfinished work. No authorization, accounting, spending threshold, deadline or retry policy is changed.

## Explicit boundaries

- The qualified interruption is an admission denial followed by host termination and complete runner destruction. Abrupt host/runner SIGKILL before final diagnostic retention is not claimed recoverable. Removing the final-snapshot requirement would risk replaying superseded completed work.
- Trusted production diagnostic artifacts retain the existing seven-day retention. An expired or missing artifact prevents automatic authenticated recovery even when Git tags still exist. The expiration test requires this fail-closed outcome. A narrowly scoped follow-up is to choose an explicit recovery horizon and retain the existing authenticated artifacts for that horizon; extending retention alone would not solve abrupt termination before upload. No retention policy is changed here.
- Browser acceptance uses the actual credential-free, network-isolated local Preview and Chromium verifier. It does not claim an externally deployed Vercel Preview or a completed Take Eleven project.
- The legacy renewal authorization used by this scenario exercises the actual token/reservation and verified-price ceiling path. It does not stand in for the separately tested current cumulative-dollar amendment path.
- The host metered-review receipt proves native engineering completion, not by itself the subsequent external PR/deployment or final DO project assessment. Those must not be inferred from a passing native receipt.

Zero paid inference is a hard test property. No success here authorizes a real provider call or changes any production task or ledger.
