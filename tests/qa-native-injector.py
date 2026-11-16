from pathlib import Path

path=Path('tests/helpers/assert-blocked-owner-recovery.mjs')
source=path.read_text()
edits=[
 ("import assert from 'node:assert/strict';",
  "import {qaCommittedOwnerRpcRace} from './qa-blocked-committed-rpc-race.mjs';\nimport {qaCaptureAuthority,qaSnapshotPublic,qaAssertInstallation,qaAssertQaIsolationUnderFreshState,qaAssertNoPrematureNewRelease,qaAssertBoundedSchedulerAfterResume} from './qa-blocked-current-state-independent.mjs';\nimport assert from 'node:assert/strict';"),
 ("  await db.query(migration);",
  "   const qaPreinstallData=await qaSnapshotPublic(db);\n   const qaPreinstallAuthority=await qaCaptureAuthority(db);\n   await db.query('reset role'); // Restore schema owner after read-only QA probes.\n   await db.query(migration);\n   await qaAssertInstallation(db,qaPreinstallData,qaPreinstallAuthority);"),
 ("  const offer=(await get()).rows[0].r;",
  "  if(process.env.KATIE_QA_COMMITTED_RACE==='1'){\\n   // Commit all synthetic schema and historical fixtures to make functions visible on both connections.\\n   await db.query('commit');\\n   await qaCommittedOwnerRpcRace(db,rival,{owner,project:ORIGINAL,priorWindow:ORIGINAL_WINDOW,priorCutoff:EXPIRED});\\n   console.log('INDEPENDENT_QA_COMMITTED_OWNER_RPC_FIXTURE_PASS');\\n   process.exit(0); // Dedicated QA race subprocess only, after all independent assertions.\\n  }\\n  const offer=(await get()).rows[0].r;"),
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
