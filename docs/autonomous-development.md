# Katie autonomous development

This is an **approval-gated** development orchestrator. You open one GitHub issue named `[agent] Objective here` describing the outcome and constraints. Everything up to a draft PR is automatic; you do not relay messages between agents.

## Lifecycle

1. Owner-authored issue triggers the workflow. It creates a unique development branch.
2. Codex implementation agent inspects code, develops the change, and writes tests.
3. An isolated Actions job installs dependencies and runs `npm run typecheck && npm run ci:gate` with placeholder service credentials.
4. A separate read-only Codex reviewer evaluates the actual diff against the original objective and full test log, returning structured findings.
5. If tests fail or review requests changes, a new Codex repair agent reads both artifacts, fixes code, and reruns the gate. A second independent reviewer checks the repaired result.
6. Workflow posts results and links to logs on the original issue and draft PR. **No auto-merge or production deployment.**

## One-time setup and activation

- Merge this orchestration PR into `main` **after human review**. Until then, the GitHub Actions issue trigger is not active.
- Set repository Actions secret `OPENAI_API_KEY` to a project-scoped OpenAI Platform API key. A Vercel variable of the same name does **not** reach GitHub Actions. **ChatGPT/Codex subscription usage does not substitute for Platform API billing.** Set an appropriate project spend limit.
- Ensure GitHub repository Actions settings allow the `GITHUB_TOKEN` read/write access **and** permit Actions to create pull requests. If either is disallowed, the workflow must stop rather than requesting broad new secrets.
- Do **not** add production Supabase, Vercel or RunPod secrets to this workflow.
- Create an owner-authored GitHub issue with title prefix `[agent]` and a clear acceptance target, or dispatch the workflow for an existing owner-authored issue using `issue_number`.

## Operating boundaries

- The implementation agent only edits an ephemeral checkout; the workflow performs commits and opens a **draft** PR. Reviewer is independent and read-only.
- Only owner-authored issues are accepted, even for manual dispatch. An issue is treated as a task specification, not permission to bypass protections.
- The workflow rejects modifications to itself by coding agents.
- Every Codex invocation uses the scoped `:workspace` or `:read-only` permission profile. No production service credentials or deployment permissions are provided.
- A single automatic repair pass is allowed. More failures are reported as **BLOCKED**, never represented as successful.
- GitHub workflows created with `GITHUB_TOKEN` may not trigger ordinary `pull_request` workflows. The orchestration runs explicit independent gates; manually review all checks prior to merging.
- Katie's existing test baseline still contains previously identified compiler-suppression problems. The workflow adds a hard-failing `npm run typecheck`, but Work Package 1 must still be reconciled to make the complete suite trustworthy.

## First controlled test

Start with a small, safe request such as `[agent] Add regression coverage for existing retrieval behavior`. Verify automatic creation of a branch and draft PR, test output, independent review, and the issue comment. Then separately test a controlled review failure to verify the repair cycle. Do not treat a static YAML review as a successful live run.

The workflow fails immediately when that GitHub Actions secret is absent and posts a **BLOCKED** report to the owner-authored issue even if implementation never starts. It never prints the secret or requires it in the issue body.

## Controlled automatic-repair acceptance test

To validate the previously untested error-recovery path, open an **owner-authored**
issue with both `[agent]` and `[repair-smoke]` in its title. The normal
development agent implements the request. Only after development, the workflow
adds a deliberately failing, otherwise legitimate regression test in that
**isolated development branch** asserting that `package.json.private` is
`false` (its real value is `true`). The independent test gate must fail; the
reviewer should request changes; the repair agent must correct the assertion
while keeping the test; then the independent gate and reviewer must pass.

This test is explicitly opt-in, is restricted to issue events authored by the
repository owner, never runs on production `main`, and never authorizes a
merge. The resulting draft PR is a disposable acceptance-test artifact, not a
feature proposed for production. Do not use the flag for ordinary work.

## Event-driven notifications and follow-up triage

[Issue #427](https://github.com/mfackrell/katie/issues/427) is the owner-assigned notification feed. The **Katie event-driven notifications** workflow listens for GitHub `workflow_run.completed` events from Katie's autonomous development, `ci` and `migrate-and-deploy`. **No hourly polling or ChatGPT automation is involved.**

- The protected agent workflow publishes a versioned `agent-completion` artifact with the owner-authored issue, draft PR, independent test/review outcome and run ID. The event listener validates the receipt, marks the original issue `agent-ready` or `agent-blocked`, and posts one linked, @mentioned status update to #427. Missing/invalid completion information never implies success.
- A BLOCKED result also automatically creates a linked, owner-assigned `[agent-followup]` review work item, including the independent review's blocking findings. This is **triage, not another automatic coding pass**. Owner-only agent authorization remains in force; no notification job merges code or deploys.
- For main-branch pushes, it waits for the same commit's CI and migration workflows to both finish and posts one combined **release-checks** notice. This is **not** proof Vercel is READY; that must be verified separately. Pull-request checks are excluded.
- Status alerts have durable per-run or per-SHA deduplication markers. Listener jobs use read-only `main` code, narrow token permissions and no production secrets. Artifacts and reviewer findings are treated as data, not executable instructions.

**Delivery:** GitHub's normal issue notifications (web/mobile/email) apply if #427 is subscribed and notifications are enabled in GitHub. GitHub cannot deliver a new message directly into an inactive ChatGPT chat, and this workflow does not promise that. A self-mention alone may not generate a separate mobile push. The workflow does not auto-approve or auto-merge draft PRs.

Test the pure event/receipt classification with `node --test tests/katie-event-notifier.test.mjs`. A live `workflow_run` and a new comment on #427 must be verified after merging the handler into `main`.
