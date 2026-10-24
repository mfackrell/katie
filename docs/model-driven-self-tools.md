# Model-driven self-inspection implementation checkpoint

This is a partial implementation of AGENT_REQUEST.md. It is not evidence of authenticated live acceptance or completion of the full read/write request.

## Implemented

Ordinary standalone Katie self-inspection messages use the existing router-selected provider/model with native function calls. OpenAI uses Responses for reasoning models and Chat Completions for other models; Gemini, Anthropic and xAI use their native function protocols. Reasoning items and Gemini thought signatures survive tool continuations. Other conversation paths retain their existing generation behavior. Executive and managed actors do not gain these tools.

The loop validates strict tool arguments, revalidates actor/chat/request binding before model turns and tool execution, limits calls/turns/time/output, and writes append-only started/completed/blocked receipts. It fails closed when authorization or durable receipt storage is unavailable. Retries share the request call budget and restore the source SHA from completed receipts. External tool calls have no automatic retries. Credentials remain in server-side request headers; upstream error bodies are discarded.

Supported tools:

- GitHub own repository source pin, bounded source tree/files, commit ancestry and CI/status inspection. Source reads use an immutable SHA in mfackrell/katie. Credential paths and extra repository/ref arguments are rejected. Repository HEAD is explicitly distinct from production SHA.
- Supabase fixed application-table schema metadata and actor/chat-scoped request/receipt reads. No other actors' rows, generic SQL, arbitrary table selector or management API is exposed.
- Vercel deployment metadata and production verification against connected project, READY state, GitHub source repository, SHA and current katie-mu.vercel.app alias assignment. Missing credentials return explicit setup requirements. Inspection never implies deployment authorization.
- Capability status for material changes, describing the approval/connection checkpoint rather than claiming a write succeeded.

Apply `supabase/migrations/20261023120000_self_tool_receipts.sql` through the existing authorized migration workflow before enabling live inspection. It creates service-only insert/select receipts with actor/chat/request association enforcement and a fixed schema RPC. This implementation run did not apply migrations or access any production resource.

Vercel onboarding requires server-side `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, and `VERCEL_TEAM_ID` for a team project. The token must have access to the connected Katie project. No token is requested in chat, stored in receipts, or returned to the model. This adds a connection requirement, not a token-entry UI.

## Remaining implementation requirements

The full request remains incomplete. Existing `lib/agents/development.ts` approval, dispatch, immutable receipt and independent review mechanisms are preserved. The new loop does not expose direct branch/file/commit/PR/merge mutations or mint development approval. It does not replace the trusted Codex workflow with an unreviewed text model executor. That executor's existing model compatibility restriction is unchanged.

Supabase reviewed DML/migration admission, before/after evidence, disposable acceptance records and redacted management/application logs still need scoped authorized operations. Vercel deploy/rollback admission, deploy polling and runtime log readers still need implementation. New tools intentionally report these unsupported capabilities as blocked. Project-specific estimate/admission accounting is not added; loop limits are runtime safety guards, not a project budget estimate.

## Acceptance checkpoint

Repair checkpoint: self-tool calls now require `Authorization: Bearer <Supabase Auth session>`, verified through the connected `/auth/v1/user` endpoint; `NEXT_PUBLIC_SUPABASE_ANON_KEY`; a server-configured `KATIE_SELF_ACTOR_ID`; and an explicit service-managed `self_tool_owner_grants` row binding that Auth user to the actor and chat. Neither a Katie display name nor supplied IDs establish ownership. Apply `20261023130000_self_tool_owner_grants.sql` after the receipt migration. Provision grants only after an administrator verifies ownership; no chat tool can create grants. Missing configuration, session or grant fails closed. The ordinary chat client does not yet provide an Auth session, so live self-tools remain blocked until authenticated client onboarding is connected. Credentials must never be pasted into conversation text.

Authentication and grants are rechecked before each model turn and invocation, and new receipts record the verified owner ID. A database trigger rejects new receipts without a matching grant. Existing receipt history is preserved. The migration has not been applied or tested against a running database in this repair environment.

The clarification harness now supplies the tool flag and caller context; it covers ordinary generation and tool-enabled dispatch with the selected model. Local tests also cover missing/invalid sessions, server identity mismatch and absent owner/chat grants. These checks are mocked local regression evidence only.

Unresolved requirements remain **blocked/incomplete**: the reviewed GitHub mutation workflow, reviewed Supabase DML/migrations and log readers, approved Vercel deploy/rollback and logs, durable project-specific spending estimates/admission/accounting, and real conversation acceptance. They are not satisfied by the inspection tools or this authorization repair. Production acceptance cannot be performed under the repair instruction prohibiting production access; no production, push, merge or deployment action was taken.

Repair verification: TypeScript checking, test compilation, the 19 model-tool tests, the 14 clarification routing tests, targeted tool/provider ESLint checks, and the production build passed locally. The build's production Storage probe skipped as designed outside production. The complete `ci:gate` attempt encountered sandbox `spawnSync ... EPERM` errors across subprocess tests; `check:url` likewise failed to spawn its shell. The localhost runtime smoke command failed in this sandbox. Consequently no passing complete gate or runtime smoke is claimed. Tests and workflow checks were not weakened or bypassed.

Only local mocked transport/regression tests were run. They do not prove credentials, live provider tool compatibility, database migration application, production CI, deployment or alias access. No PR, commit, production acceptance receipt or external success evidence was created by this implementation run.

An authorized staging/live acceptance run must use an ordinary authenticated Katie conversation and preserve its request ID, actual model ID, tool receipts and independent reviewer evidence. It must first verify source pin/read and deployed SHA/alias without conflating them. After the remaining write operations are implemented, it must create an isolated harmless branch/change and disposable actor-bound database record; verify source-bound CI and independent review; obtain the required owner authorization; deploy the approved immutable commit; verify READY and current production alias/SHA; and clean up disposable resources. Each unsupported capability must leave a visible blocked checkpoint. Do not substitute mocked results for any live acceptance item.


## Current-main recovery: owner sign-in wiring (2026-10-24)

The integration branch supplies `components/self-tools-owner-session.tsx` and `lib/tools/browser-owner-session.ts` for email-link authentication via Supabase Auth. The ordinary Katie chat POST conditionally attaches the authenticated access token. Only the *server* authorizes use, requiring an explicit configured `KATIE_SELF_ACTOR_ID`, a standard actor, a valid Supabase Auth token verified server-side and an owner/actor/chat row in `self_tool_owner_grants`. An editable actor display name is never authorization. No service-role credentials enter the browser.

These changes DO NOT bootstrap an owner automatically. An administrator must separately:
1. Configure the Supabase Auth public URL/key for the client and server, email-link redirect allowlist, and `KATIE_SELF_ACTOR_ID` bound to the verified Katie actor UUID.
2. Apply and validate both reviewed migrations using the single authorized migration workflow, after successful CI and staged schema compatibility testing.
3. Complete owner Auth login and independently verify the authenticated user's identity before provisioning a scoped owner/actor/chat grant through a reviewed administrative channel.
4. Run the real model-to-tool acceptance conversation and inspect pinned Git SHA, provider/model provenance, durable tool receipts and source inclusion.

No production grant or credential onboarding is implied by merging code. Missing setup must fail closed. Provider-native read operations and change-capability reporting do not fulfill the full GitHub/Supabase/Vercel mutation workflow requested by issue #688.
