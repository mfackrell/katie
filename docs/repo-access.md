# Repository Access and Content Injection

## Overview
The repo content injector enriches Katie's prompt with real source text from the active GitHub repository when code inspection is required.

## Supported triggers
- Intent: `code-review`
- Intent: `architecture-review`
- Message keywords: `review file`, `check code`, `see the repo`, `debug this code`, `inspect code`

## Data flow
1. Resolve active repo by `repoId`.
2. Parse user message for path/file hints.
3. Fetch candidate file contents using GitHub API on the active repository only.
4. Apply lightweight relevance scoring using message keywords + file path/content preview.
5. Redact likely secrets and inject formatted file blocks into prompt context.

## Limits and guardrails
- Read-only GitHub access.
- Text file extraction only (`ts`, `tsx`, `js`, `json`, `md`, `yml`, etc.).
- No binary file injection.
- Max files injected: 5.
- Max total injected payload: 20k characters.
- In-memory cache TTL: 5 minutes.
- Local rate limit: 10 GitHub fetches per minute.
- If a file cannot be fetched, injector emits:
  - `[REPO ACCESS ISSUE: Could not fetch <path>. Paste manually?]`

## Authentication
Set one of the following environment variables for GitHub API auth:
- `GITHUB_TOKEN` (preferred)
- `GITHUB_PAT`
- `GH_TOKEN`

For private repos, token must have sufficient read permissions.
