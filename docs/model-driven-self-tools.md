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

Only local mocked transport/regression tests were run. They do not prove credentials, live provider tool compatibility, database migration application, production CI, deployment or alias access. No PR, commit, production acceptance receipt or external success evidence was created by this implementation run.

An authorized staging/live acceptance run must use an ordinary authenticated Katie conversation and preserve its request ID, actual model ID, tool receipts and independent reviewer evidence. It must first verify source pin/read and deployed SHA/alias without conflating them. After the remaining write operations are implemented, it must create an isolated harmless branch/change and disposable actor-bound database record; verify source-bound CI and independent review; obtain the required owner authorization; deploy the approved immutable commit; verify READY and current production alias/SHA; and clean up disposable resources. Each unsupported capability must leave a visible blocked checkpoint. Do not substitute mocked results for any live acceptance item.
