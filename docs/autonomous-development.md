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
