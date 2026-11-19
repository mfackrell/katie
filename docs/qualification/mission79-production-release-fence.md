# Mission 79 — production release fence and owner approval contract

**Scope:** Only original project `fe9d2658-41e3-44c1-ae8e-a0cba98371fe`, original mission 79 and saved assignment. This document is an **operator control**, not an owner authorization or authorization to release.

## Verified Vercel release setting

On 2026-11-18, the linked Vercel project's **auto-assign custom production domains** setting was explicitly disabled, using the authenticated first-party Vercel project API.

- Team: `mark-fackrells-projects`
- Project ID: `prj_HuonAMnD6OhPAZ8tYVlyqQ5OjcEL`
- Vercel audit event: `uev_hHJOBoOKzZUzxwuFIybRr7RS`
- Event type: `project-auto-assign-custom-production-domains-updated`
- Verified audit payload: `{"projectId":"prj_HuonAMnD6OhPAZ8tYVlyqQ5OjcEL","projectName":"katie","autoAssignCustomDomains":false}`

This setting prevents **automatic custom-production-domain assignment**, but cannot by itself block a privileged administrator from manually promoting a different deployment. A production retest is permitted only while the release operator actively controls that remaining privilege.

## Mandatory operator serialization

1. Confirm separately executed independent security QA **PASS** and full CI **PASS**, both against the final exact PR SHA/tree. Do not merge on a partial or failed gate.
2. Freeze other production merges and **manually promoted aliases** for the duration of this single recovery. Inspect the current canonical `katie-mu.vercel.app` alias and its exact deployment ID and SHA.
3. A bound, zero-attempt original mission79 is still an unspent owner authorization. The gate **rejects CLOSE** until normal cron takes its lease, or the exact bound runtime terminally settles an expired unleased window. Do not promote across that rejection or fabricate another binding.
4. Before any deployment can take ownership of the canonical alias, **close** the original DO SQL release gate with the postgres-owner-only `project_org_retest_set_release_gate(...,'closed')`, verifying its recorded active generation/deployment and original owner scope. All mission79 claims fail while closed; do not use ad hoc updates.
4. Promote the reviewed READY production deployment via the supported Vercel deployment alias/promotion API. Read back the **actual canonical alias's** deployment ID and commit SHA from Vercel. The application's own `VERCEL_GIT_COMMIT_SHA` is insufficient proof.
5. Only after confirming that alias mapping, activate the **exact** verified deployment ID and SHA in SQL by `project_org_retest_set_release_gate(...,'active')`. The operator must supply the observed current SQL generation as the fifth RPC argument (use **0** only for initial registration); the database rejects stale CLOSE/OPEN requests under its lock. The new gate generation invalidates every prior worker preflight observation.
6. The runtime must independently observe this current SQL generation, verify the canonical alias, and pass the observed generation to `claim_mission_work_release_epoch`. PostgreSQL rechecks **the same exact generation** under the existing global claim locks. Older worker deployments may use the legacy claim function only for unrelated ordinary missions, not renewed mission79.
7. Record a **separate owner-chosen future cutoff** using Katie's authenticated first-party UI. The original expired 2026-11-18 14:00 UTC cutoff is immutable; the owner must pick the new date/time, not the operator. No default deadline, receipt synthesis, cap increase, or worker commission is allowed.
8. After a real owner receipt, bind the exact current release to mission79 using the first-party owner control. Allow normal cron to claim the existing assignment. Stop at the first actual LLM management outcome and verify its saved decision/assignments. Do not manually invoke the provider.
9. If the release gate or alias changes, **close the SQL gate before any further alias promotion**, and stop; do not retry paid inference or renew the owner authority without explicit approval.

**Limitations:** No application or database mechanism can prevent an unrelated privileged Vercel administrator from manually moving the alias outside this operator protocol. The auto-assignment setting, restricted postgres-owner gate setter, generation-pinned worker claim, current-alias verification, and explicit release freeze are complementary controls. If manual alias ownership cannot be exclusively controlled and reverified, do **not** claim production release qualification.
