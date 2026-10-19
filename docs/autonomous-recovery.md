# Katie autonomous recovery control plane

## Purpose
Katie's recovery system applies to **any** saved project, managed mission, or agent task. The token-board game is a test case, not a specialized agent architecture. The recovery supervisor is invoked by the existing authenticated per-minute mission cron and runs independently of ordinary work.

## Durable lifecycle
1. **Detect.** A service-role Postgres function discovers recent blocked projects, missions, and tasks idempotently, using source ID and version. Historical completed, paused, or stopped work is never restarted.
2. **Claim.** A separate advisory lock and four-minute lease allow only one live recovery owner. Diagnosis is limited to two attempts per case and a bounded number of cases per original source.
3. **Gather evidence.** Preserve existing assignment/mission/project records, immutable GitHub workflow/test artifacts and approved project scope. Secret patterns are redacted; untrusted logs cannot grant permissions.
4. **Diagnose.** Hard-coded policy checks budgets and owner permissions first, then distinguishes provider transients, verified infrastructure failures, application defects and unknown failures. Ambiguous cases receive one tool-free, capped independent model diagnosis; the model has no action authority.
5. **Delegate.** Transient *ordinary* mission assignments may be replayed once under their original deadline, model-token ceiling, authorization, and job-attempt limits. Repairs with verified repo evidence create an owner-authored GitHub issue for the existing Codex implementer plus separate CI and independent review. GitHub repair scope markers pin the exact prior SHA and an allowlist; the workflow verifies those limits before each push. Scope cannot be expanded by the coding model or by a suggested reviewer fix.
6. **Verify.** Same-commit project re-verification is preferred over recoding. Repair PRs are recognized as reviewed only if a trusted machine-readable GitHub completion receipt passes tests, independent review, and the approved browser contract if present. A proposed PR is not success.
7. **Release/resume.** The system does **not** silently merge, deploy, access credentials, increase budgets or approve a new coding scope. A human owner must merge shared repairs. Once a reviewed infrastructure repair is on the verified production/main commit, Katie can re-run the original project against the unchanged approved code and resume without increasing its coding-cycle counter. Original completion remains contingent on existing independent acceptance.
8. **Surface.** The Agents dashboard shows recovery case states, specialist assignment issues, owner review gates and results.

## Failure boundaries
- No source-specific game logic, hardcoded project IDs, or unrestricted code-agent permissions.
- Missing GitHub permissions, secrets, provider moderation differences, insufficient funds, expired authorization and exhausted model budgets require owner review.
- Broken or malformed evidence never causes inferred success or privilege escalation.
- Unknown root causes retain original outputs and a diagnostic record rather than triggering speculative code changes.
- Retry/recovery records are append-only audit events, and project/mission charges are never reset.
- A missing recovery subsystem must not stop ordinary project and mission scheduling.

## Key files
- `lib/recovery/policy.ts`: deterministic permission/route classifications.
- `lib/recovery/diagnose.ts`: one bounded, read-only independent diagnosis.
- `lib/recovery/worker.ts`: orchestration, GitHub evidence and specialist delegation.
- `supabase/migrations/*recovery*.sql`: durable state, fences and repair resumes.
- `scripts/recovery-scope.mjs`: pinned source SHA and file allowlist enforcement in the trusted GitHub workflow.
- `components/recovery-panel.tsx`: human-visible status and release controls.

A useful regression is a permission-free ordinary transient failure, followed by a genuine independently reviewed repository failure, then a verified infrastructure error. Assert no third coding cycle is spent when the same reviewed code can be re-verified.
