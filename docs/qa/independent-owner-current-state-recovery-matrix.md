# Katie DO — independent owner current-state recovery QA matrix

**Independent QA owner:** Replacement Independent QA & Security Lead, separate from RRE v3.  
**Authority:** EPD v3 issue #1061 comment 6927185801.  
**Purpose:** Qualify a *future* first-party owner renewal and distinct guarded management resume for the same already-renewed/resumed, blocked, expired, ratified development project.  
**Status:** Test design / preparation only. **No new recovery candidate has been independently tested.**

## Frozen starting point and explicit limits

- #1063 released main: `20cf7da89b7bd5714dc8f81cd9c9105f9d5f0237`, accepted tree `965f96c35c28b9b32a227863cb87754c8fda67c5`.
- At QA preparation, main advanced to `3a55f4cb20cbaed8e3f48626dc46299bbca10841` via #1064; RRE must name the real new PR's parent, exact head, full tree, and any intervening main. This matrix is *not* a PASS on either commit.
- Original TTT project: `fe9d2658-41e3-44c1-ae8e-a0cba98371fe`; scope hash `4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6`. Existing 13 nodes/contracts, 76 historical missions (out of 96), zero coding packages, total 600000-token allowance, no active mission/lease.
- Prior execution cutoff `2026-11-16T18:00:00Z` has expired. Prior renewal and resume receipts have been consumed on window `a08d3cac-6e3f-4c14-a75a-5f524987a676`, continuation release `6a93ea83d59531bdcdde88eb2088b432367172a5`. Current status: blocked/development/ratified.
- Existing preflight returns **resumed** with the historic receipt, not an executable new offer; different release fails; hierarchy recovery offer is null. See #1063 comment 6925493035.
- **There is NO owner approval of a new live cutoff.** QA uses synthetic future timestamps only in disposable fixtures. Nothing in this matrix authorizes live activation, production writes, mission dispatch, inference, spending, provider credentials, scope/cap increases, or manually coding the game.

## Independent execution approach

1. QA makes and owns its own test worktree/branch, not the RRE implementation branch. Fetch exact RRE head and its parent with GitHub Actions runner or an isolated local checkout. Confirm `git rev-parse HEAD`, `HEAD^{tree}`, parent/merge tree, migration checksums, and no unexpected implementation edits. Check for a concurrent new main before final acceptance.
2. Build **production-shaped but synthetic** fixtures in PostgreSQL 16/18, with synthetic owner/actor/chat and dummy service-role keys. Fixture setup may temporarily bypass triggers as postgres to construct the expired, consumed-receipt state. **Restore triggers and ordinary roles before invoking any recovery API**; privileged seeding is not public authority evidence. Use native `clock_timestamp()` and a controllable test-only clock for the boundary. Record the post-seed state fingerprint and available offers.
3. Perform baseline **fail-before characterization**, not a full rerun of #1063: pre-candidate original project is blocked after consumed receipts; old fixed-cutoff API cannot open a new window or resume; old receipt replay only returns historical status; hierarchy offer null. Capture expected unsupported-state evidence without mutating production.
4. After RRE's candidate is published, execute the **unchanged independent negative probes** on the exact candidate's installed migration and actual route/component. Run a positive end-to-end owner authorization, then a separate explicit owner resume. Test SQL directly with `service_role` and deny both `anon` and `authenticated`; test browser/API through the normal owner bearer, not by bypassing `verifiedProjectOwnerSession`.
5. In each negative scenario, freeze all public tables or scoped project/owner/finance tables before and after the rejected call. Compare canonical row JSON (stable ordering) and count mission allowance, assignments, pending provider requests, project events, receipts, and mission calls. For positive cases compare permitted deltas only. Include cross-session concurrent calls and forced late SQL exception to verify atomic rollback.
6. Keep original #1057/#1063 acceptance and 13-contract evidence as reference, reuse exact-source results only where source-identical. **Do not rerun completed #1063 CI/suites** merely to generate another report.

## Required test cases

| ID | Scenario / action | Strict acceptance oracle |
|---|---|---|
| P01 | Old released baseline: blocked, ratified, expired, null active mission, 76/96, consumed prior receipts; read-only offers | Existing `resumed` receipt is not a new grant; prior owner preflight and hierarchy recovery cannot restart this state; **zero mutation** |
| P02 | Exact candidate migration installed in clean populated fixture | Zero unintended pre/post row changes; predecessor function bodies/security settings and historical #1057/#1063 receipts intact; additive schema/ACL reviewed |
| P03 | No owner consent; read-only offer/refresh/browser status | No renewal, no resume, no mission, no new window, no provider call; no implicit selected cutoff |
| A01 | Logged-out browser, missing bearer, invalid bearer, authenticated non-owner | HTTP 401/403 equivalent before any write RPC; no authority and no user-controlled owner-ID substitution |
| A02 | Correct owner but foreign project, foreign actor/chat binding, or malformed project identity | Deny; no mutation of either project |
| A03 | Correct owner; stale/foreign release SHA, stale branch/tree, unexpected deployment, changed approved source | Deny; exact active-source binding required across offer, authorization, resume, claim |
| A04 | Tampered state hash, stale preflight, changed status/phase, changed active mission/lease, changed provider window/release | Deny under lock; no new receipt or mission |
| A05 | Expired, backward, null, infinite, non-UTC/malformed, outside permitted bound, or arbitrary unapproved cutoff | Deny; server cannot infer/choose a new live cutoff |
| A06 | Old window/release/renewal/resume receipts replayed as current authorization | Historical status may be read but **cannot grant** new authority, renew twice, or reenable old assignment |
| A07 | Correct new renewal request but wrong owner, source-mission, scope hash, objective, approval hash, or any one of 13 contracts | Deny; original scope and all contracts remain unchanged |
| A08 | Invalid parent/QA ancestry, `quality_assurance` or `independent_qa` gains development tool, delegation/capability mutation | Deny; both QA designations remain isolated from coding and approvals |
| A09 | Mission cap 96 altered/exhausted, allowance 600000 altered/overspent, unresolved requests/active work/new package | Deny; do not reset counts or historical spent/actual charges |
| A10 | Two simultaneous authorization requests (same authorization ID and different IDs) | Exactly one durable window/receipt; duplicate deterministic readback if supported; no partially updated hierarchy or duplicate allowance |
| A11 | Failure injection after updating only some deadlines/receipts/events | Entire transaction rolls back; *all* 13 node deadlines and project/provider/window rows remain previous values, including receipts |
| S01 | Authenticated owner explicitly chooses a concrete synthetic future cutoff and **clicks authorize** | One durable, source/owner/state/window-bound authorization receipt; original project remains blocked/inactive, no mission/claim/inference; verify full recorded cutoff and identity |
| S02 | Lost or duplicated authorization HTTP response | Read back immutable receipt; UI does not automatically invoke resume; exactly one authorization |
| S03 | Correct owner separately **clicks resume** with current authorization, state hash, release and project | Exactly one guarded transition toward running/management; preserve all 13 contracts, history and resource caps; no worker dispatch or paid provider call |
| S04 | Resume before authorization; wrong/stale/exhausted auth ID, stale state, changed scope, wrong release/owner, expired window | Deny with zero mutation; no fallback to generic resume/restart |
| S05 | Two simultaneous resumes, retry after network loss, replay of consumed new resume receipt | At most one real state transition and bounded management admission; idempotent evidence-only receipt when permitted, never second mission or allowance debit |
| S06 | Complete legitimate scheduler step after separate resume, with valid lease/release/window | At most one bounded management mission; no claim on old/foreign release; no direct worker assignment, package, provider call or spent tokens from owner clicks |
| S07 | Rollback after successful-looking internal writes; stale/expired lease, deadline, node, phase or window at scheduler | Atomic rollback and existing lease/claim fences retain historical evidence and zero unauthorized admission |
| H01 | Pre/post history comparison for original ID | Project identity, exact scope/hash, 13 nodes/contracts/delegation/QA isolation, old mission/assignment/decision/exception/event/receipt history retained; authorized new rows append-only |
| H02 | Financial/resource history | 96 total missions, 600000-token cap, historic 76 missions and their charges unchanged by authorization; 20 remaining slots do not become 96 fresh slots; no new token usage prior to actual paid execution |
| H03 | Installed ACLs, `SECURITY DEFINER`, search-path pinning, RLS, original predecessor function digests | New owner-control SQL entries callable only by authorized service path; `anon`/`authenticated`/worker cannot invoke privileged writer or bypass predecessor; no expanded owner authority |
| B01 | Actual first-party UI, real HTTP/API, browser and native PostgreSQL | Authenticated owner can **review cutoff → authorize → refresh receipt → separately resume**. No action from page load/refresh alone; errors don't leak credentials; status/receipts accurately render |
| B02 | Browser wrong-user, anonymous, clock-expired, lost response, manipulated input, second click | Denials/visible state are correct, no duplicate POST on refresh, no auto-resume and no implicit authorization |
| C01 | Protected original project's old claim/recovery paths under changed release/window | Claim fence, source-binding, replay and rollback remain effective; no paid inference/provider requests in QA |
| C02 | Candidate mixed with current main & unrelated changes | Required affected checks PASS on **exact combined tree**. If head/tree changes, redo affected tests and rebind verdict |

## Evidence and gates

- A FAIL in any **A**, **S**, **H**, **B**, or **C** test is a candidate blocker. Do not call source inspection or engineering logs independently executed QA.
- Report baseline failure reproduction, test commands/environment, runner URLs/job IDs, original independent probes and hashes, exact candidate SHA/tree, exact tested merge tree, SQL function definitions/ACL digests, before/after snapshots, browser screenshots/receipt trail (synthetic only), and detailed PASS/FAIL/UNVERIFIED per ID.
- The final QA verdict must be **PASS**, **FAIL**, or **UNVERIFIED** on a named exact candidate, and explain any separate CI or runtime blocker. Do not grant an execution window, release approval, game acceptance, or internal Director final closure.
- EPD v3 retains release authority. Independent QA must separately verify the eventual actual browser game in protected Preview against its deployed commit and the approved specification; infrastructure acceptance is not game acceptance.
