# Native development work-in-progress preservation

The trusted native host saves unfinished implementation and repair source before
each authenticated model request reaches admission. It also attempts a save when
the coding child exits, including a failed phase. A persistence failure blocks
the next model request. Preservation does not reserve tokens, reconcile charges,
issue grants, extend deadlines, retry a failed run, or mark a task complete.

Snapshots are immutable Git tags in the existing repository:

`refs/tags/katie-wip/<task-id>/<run-id>-<run-attempt>/<sequence>`

Each tag points to a commit containing the approved-scope worktree snapshot and
a bounded JSON commit message. The message records the original baseline,
approved paths and scope hash, project/task/trial/approval/grant identities,
execution epoch, phase, source tree, completed checkpoint, sanitized review
findings, and last completed phase/settled model call. The tag's commit SHA is
the checkpoint hash; the same SHA and metadata appear in retained diagnostics.
Every snapshot is explicitly `native-unverified-wip` / `unverified`.

The ordinary candidate branch and real index are unchanged. Both existing scope
gates validate a private index before publication. Reads reject links and bound
file count/content size; Git clean filters are not executed. Tags are used rather
than candidate branches, so WIP is not submitted to candidate deployment/review.
Existing tags are never overwritten. A remote readback must confirm the exact
commit before execution can proceed. The Git snapshot is independent of runner
storage and diagnostic artifact retention.

## Same-task restoration (Deliverable B)

The native host lists the original task's remote WIP tags before consuming a new
owner execution grant. The unique latest run/attempt/sequence must match the SHA
and metadata in `native-execution-diagnostics` from the failed run in the
service-owned task receipt. The reader checks repository, workflow, main branch,
run attempt, task and issue identity. A Git tag cannot authenticate itself.
Missing, expired (currently seven-day retention), ambiguous or inconsistent
artifacts block recovery; retained Git source is not deleted or silently restarted.
A runner killed before diagnostic upload can preserve source without sufficient
authentication evidence for automatic restoration. This fails closed.

Provenance also binds the project mission assignment, original baseline/base,
approved paths/scope hash/contract, historical approval and grant, completed
checkpoint, and last settled request to existing authoritative records. Reads
never change calls, tokens, reservations, receipts, deadlines or approvals.
Historical requests remain attached to their own grants even if a later host is
interrupted before completing its first new request.

Both complete trees pass the unchanged scope gates in a private index before
restoration. A fresh runner retains the trusted completed commit as HEAD and
restores unfinished additions, modifications and deletions as unstaged WIP.
Dirty runners, ref races and newly arrived work are rejected before mutation.
The immutable WIP ref and candidate ancestry remain available.

Repair checkpoints retain their original findings and completed review/verifier
evidence. New snapshots keep structured evidence in existing `lastCompleted`;
legacy v1 snapshots require unique corroborating entries in the same trusted
artifact. Missing completed-phase evidence blocks recovery. An interrupted
repair continues at repair, skipping implementation and initial review. It must
still pass deterministic/build/browser verification and final independent review;
the ordinary protected-preview/browser-completion pipeline remains mandatory.

Recovery is not execution authority. The actual host requires the existing,
separately approved live dispatch; restoration finishes before atomic grant
issuance, and a child starts only after that grant succeeds; every new provider request still passes the existing gateway.
The restoration helper itself performs no provider requests or grant writes and
cannot declare completion. A failed or expired authorization leaves remote work
recoverable. No owner approval, paid retry, or game execution is created by this PR.

The guaranteed boundary is the next model request: completed tool writes have
been pushed before that request can be denied. A hard runner loss during a tool
write or before its next request can still lose changes since the last confirmed
snapshot. Exit-time saving is supplemental, not a guarantee against SIGKILL or
runner destruction. Oversized, out-of-scope or unsafe source fails closed and
is not published. The most recent confirmed checkpoint remains available.

The nonbillable regression uses an independent bare Git remote, modifies two
repair files and creates a third, denies the next request, deletes the entire
runner workspace, then recovers and verifies exact contents and metadata from a
fresh clone. Additional tests cover initial creation, protected/out-of-scope
writes, links, known secrets, remote failure, duplicate saves, and blocking
admission/provider access when persistence fails.

Related: #715, #829; failure run 41139165988. Deliverable A preserves work; Deliverable B authenticates and restores it.
Neither implements Take Eleven or authorizes further inference.
