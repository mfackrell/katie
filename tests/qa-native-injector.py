from pathlib import Path

path=Path('tests/helpers/assert-blocked-owner-recovery.mjs')
source=path.read_text()
edits=[
 ("import assert from 'node:assert/strict';",
  "import {qaCaptureAuthority,qaSnapshotPublic,qaAssertInstallation,qaAssertQaIsolationUnderFreshState,qaAssertNoPrematureNewRelease,qaAssertBoundedSchedulerAfterResume} from './qa-blocked-current-state-independent.mjs';\nimport assert from 'node:assert/strict';"),
 ("  await db.query(migration);",
  "   const qaPreinstallData=await qaSnapshotPublic(db);\n   const qaPreinstallAuthority=await qaCaptureAuthority(db);\n   await db.query(migration);\n   await qaAssertInstallation(db,qaPreinstallData,qaPreinstallAuthority);"),
 ("  assert.equal(offer.priorWindowId,ORIGINAL_WINDOW);",
  "   assert.equal(offer.priorWindowId,ORIGINAL_WINDOW);\n   await qaAssertQaIsolationUnderFreshState(db,{project:ORIGINAL,owner,release:NEW_RELEASE});"),
 ("  const afterAuthorize=(await get()).rows[0].r;",
  "   const afterAuthorize=(await get()).rows[0].r;\n   await qaAssertNoPrematureNewRelease(db,{project:ORIGINAL,owner,release:NEW_RELEASE,cutoff:future});"),
 ("  console.log('BLOCKED_OWNER_CURRENT_STATE_POSTGRES_PASS:",
  "   await qaAssertBoundedSchedulerAfterResume(db,{project:ORIGINAL,owner,release:NEW_RELEASE,previousRelease:activeRelease});\n   console.log('BLOCKED_OWNER_CURRENT_STATE_POSTGRES_PASS:"),
]
for before,after in edits:
    found=source.count(before)
    if found!=1:
        raise SystemExit(f'QA injection anchor mismatch: {found} occurrences: {before!r}')
    source=source.replace(before,after,1)
path.write_text(source)
print('INDEPENDENT_QA_ONLY_INJECTION_PASS: five guarded test-only insertions; no implementation files changed')
