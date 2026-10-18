# Project acceptance helper interfaces

These helpers are integrated by the persistent project coordinator and native workflow. See [chat-projects.md](chat-projects.md) for the full architecture, permissions, lifecycle and verification contract. The earlier helper-only draft was incomplete; its historical limitations are not represented as a successful project release.

## Trusted request context

```
node scripts/project-context.mjs prepare ORIGINAL_AGENT_REQUEST.md
```

Writes exactly one JSON value to stdout: `null` when there is no marker, otherwise the validated object from the request's single exact marker:

```
<!-- katie-project: BASE64URL_JSON -->
```

The decoded object has exactly `version`, `projectId`, `baseSha`, `contractHash`, `contract`. Version is 1; projectId is a UUID; baseSha is 40 lowercase hex characters; contractHash is 64 lowercase hex characters. `contractHash(contract)` uses SHA-256 over recursively key-sorted canonical JSON (arrays retain order, JSON string/number encoding). `projectMarker(context)` validates and encodes a context. These and `parseProjectContext`, `validateContract`, `canonicalJSON`, and `internalPath` are exported.

Malformed, duplicate, oversized, noncanonical base64url, invalid UTF-8, extra fields, invalid paths, and digest mismatches exit nonzero with no JSON on stdout. Decoded metadata is limited to 32,000 bytes. Contract fields are exactly `{path,scenarios}`; each scenario has exactly `{name,steps}`. Scenario names are unique. Limits are 1–20 scenarios, 1–100 total steps, nonempty per-scenario steps and at least one rendered-state assertion per scenario. Actions use these exact fields:

| action | required fields |
| --- | --- |
| goto | action, path |
| click, expectVisible | action, selector |
| fill, expectText | action, selector, value |

Navigation paths start with a single slash; external/protocol-relative URLs, backslashes, whitespace, fragments, path traversal and encoded variants are rejected. Obvious document-exists assertions (`html`, `body`, `*`, `:root`) are rejected. This is structural validation, not proof that the contract covers the original objective. Approval and independent assessment still need to verify gameplay, AI, multiplayer and every other original requirement.

The parser authenticates neither the author nor the approved scope. The **server-owned, DB-bound dispatcher** generates the marker from approved stored metadata, verify the target repo and exact prior READY tested/reviewed head, and reject markers in all source/model inputs. Do not treat a successfully parsed marker as scope approval. Do not read baseSha from prose. Before switching to a new isolated branch at the validated baseSha, retain the original request and the trusted helpers from the original main checkout. Ordinary tasks continue to start from main. No workflow file is changed here.

## Actual browser acceptance

```
node scripts/project-browser-check.mjs --request ORIGINAL_AGENT_REQUEST.md --port 3109 --output project-acceptance.json
```

For ordinary requests, exits successfully without starting an app or writing an acceptance artifact. Project requests start the **already-built** Next app with the installed Next CLI, bound to `127.0.0.1:PORT`. The port must be free. The checked git HEAD must descend from the context baseSha and remain unchanged during the check. The Next process must reach readiness and remain running. Do not run a development server or substitute a static fixture for the built project.

The helper uses installed playwright-core and @sparticuz/chromium. It opens each approved scenario at contract.path and executes only the closed action list, with real DOM interactions. `expectText` requires exact trimmed rendered text and visibility; it retries within the step deadline. `expectVisible` requires a visible application element. There is no model-supplied JavaScript, shell, eval, screenshot substitute or unconditional passing check. All scenarios must execute and all assertions must pass.

Browser HTTP traffic and navigation are restricted to the exact local origin. External subresources/redirects, WebSockets, popups and downloads fail the scenario. Service workers are disabled. The application subprocess receives a minimal environment with placeholder OpenAI/Supabase values, without inherited GitHub/provider/cloud credentials. Next's automatic `.env`, `.env.local`, `.env.production` and `.env.production.local` files cause refusal; use a clean CI checkout. The browser routing policy is **not an OS network sandbox for arbitrary server-side application code**; run this in an isolated CI environment without production credentials or network access to production resources. No preview or model URL is fetched by this helper.

Execution has a 150-second budget, a 30-second server readiness window, a bounded browser launch timeout, step timeouts of at most 10 seconds, and bounded error/log strings. Browser/server cleanup runs in finally. Output is:

```
{version:1,projectId,contractHash,headSha,passed,checks:[{name,passed,detail}]}
```

Startup/runtime errors produce failed evidence and nonzero exit. A failed browser run must be repaired and rerun against the same frozen original contract. Preserve **both** helper files together (the runner imports `./project-context.mjs`) outside the candidate's writable checkout. Use a trusted wrapper/import of `checkProject` if their preserved location differs from their command-line location. Never execute the candidate's replacement copies as trusted acceptance code.

## Completion receipts and preview evidence

`parseCompletionReceipt(raw, repository, issue, run, conclusion, projectBinding?)` retains ordinary v1 behavior. Project callers must supply a server-owned binding:

```
{projectId, contractHash, scenarioNames: approvedContract.scenarios.map(s => s.name)}
```

A project receipt must contain `projectAcceptance` with the runner's exact output shape. READY requires all checks to pass, exactly the approved ordered scenario names, the saved project ID/digest, and `projectAcceptance.headSha === tested_head_sha === reviewed_head_sha`. A receipt with projectAcceptance but **without** the server-owned project binding is BLOCKED. Missing browser evidence also blocks a bound project. All existing native build/test/review/repair requirements still apply. Repaired results must include the repaired head's browser result.

`reconcileDevelopment(task, projectBinding?)` and `developmentEvidence(task, projectBinding?)` accept that same binding. The project coordinator obtains it from the approved DB record; it must not accept a browser/model override. The project coordinator obtains this binding from the immutable approved project run.

`developmentPreview(task, projectBinding, approvedOrigins = [])` verifies the connected repository, receipt, live same-head open draft PR, and GitHub deployments/statuses with the existing owner credential. It returns `{url,headSha,deploymentId,statusId}` only for a same-head non-production Preview deployment with latest successful status. It rechecks the PR head before returning. It returns null when no verified preview exists. It never fetches the deployment URL or creates a deployment. URLs must be HTTPS on a direct subdomain of `vercel.app`, or an exact origin in the server-supplied allowlist; userinfo, nonstandard ports and fragments are rejected. The public helper `verifiedPreviewUrl` validates only URL policy, not deployment identity.

The coordinator retains awaiting-delivery state for null; a local passing browser result is not a deployed playable result. It must perform original-objective assessment and persist delivery in the original chat before calling a project complete. Native coding token usage/ceilings and cumulative lineage enforcement also remain unimplemented, rather than being inferred from these receipts.

## Validation

Run the parser, browser and runtime tests with the existing test runner. Linux user/network/PID namespaces are required for isolated application execution. Local environments that deny namespaces fail closed; Linux CI must execute the real isolation test. The parent coordinator obtains all project bindings from approved database records; it is not an alternate model-controlled dispatch route.
