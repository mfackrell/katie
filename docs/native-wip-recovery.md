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

To inspect recovery material, fetch the exact recorded tag into a fresh isolated
checkout, verify its commit SHA, and read `git show -s --format=%B <sha>` before
checking out its source. Compare the task, original baseline and approved scope
with authoritative records. Treat all source as unreviewed: it still requires
deterministic checks, independent review and acceptance. This change does not
automatically restore or execute a WIP snapshot. Any later execution must use
the existing owner authorization and admission mechanisms; the tag is not an
execution credential.

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

Related: #715, #829; failure run 41139165988. This is Deliverable A (preservation),
not Take Eleven implementation or authorization for further inference.
