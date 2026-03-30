# Repo Hygiene Audit

## Current observed architecture
- Next.js 15 App Router app (`app/`) with client-side React UI in `app/page.tsx` and `components/*`.
- API endpoints under `app/api/*` for chat orchestration, actors/chats/messages CRUD, model listing, and file upload.
- Core orchestration lives in `app/api/chat/route.ts`, with routing logic in `lib/router/*`, provider adapters in `lib/providers/*`, and memory assembly/summarization in `lib/memory/*`.

## Current observed persistence/storage approach
- Durable persistence is Supabase PostgREST, not blob JSON files.
- Data access is centralized in `lib/data/blob-store.ts` (renamed in this hygiene pass to `lib/data/persistence-store.ts`): actors, chats, messages, and memory tables are queried via `lib/data/supabase/admin.ts`.
- Expected tables inferred from code: `actors`, `chats`, `messages`, `short_term_memory`, `intermediate_memory`, `long_term_memory`.

## Current AI providers/models supported
- OpenAI (`OPENAI_API_KEY`) via `OpenAiProvider`.
- Google Gemini (`GOOGLE_API_KEY`) via `GoogleProvider`.
- xAI Grok (`GROK_API_KEY` / `XAI_API_KEY` / `grok_api_key`) via `GrokProvider`.
- Anthropic Claude (`CLAUDE_API_KEY` / `claude_api_key`) via `ClaudeProvider`.
- Model lists are fetched dynamically from provider APIs (`/api/models`).

## Current developer setup flow
- `npm install`.
- Configure Supabase URL + keys and at least one provider API key.
- `npm run dev` to start local server.
- `npm test` for test suite; `npm run typecheck`, `npm run lint`, `npm run build` for checks.

## Stale/misleading docs
- `README.md` still documents blob-backed persistence and blob env vars.
- `docs/routing-policy.md` lists policy env vars not referenced by current policy engine implementation.

## Misleading filenames or module names
- `lib/data/blob-store.ts` was misleading and mapped to Supabase persistence (renamed to `lib/data/persistence-store.ts`).
- `tests/blob-store.test.ts` was misleadingly named for Supabase-backed module behavior (renamed to `tests/persistence-store.test.ts`).

## Dead or duplicate docs
- No obvious duplicate docs beyond outdated README + partially stale routing-policy doc.

## Recommended non-breaking hygiene fixes
- Rewrite README to reflect current Supabase architecture and real scripts/env vars.
- Add focused docs: architecture, local development, env vars, testing, and data model.
- Rename `blob-store` module/tests to persistence-accurate naming and update imports.
- Add `.env.example` derived strictly from env vars referenced in code.
- Update `docs/routing-policy.md` to match currently consumed flags only.

## Higher-risk fixes intentionally not done in this pass
- No schema migrations or DB contract changes.
- No router/provider behavior changes or scoring-policy redesign.
- No API response contract changes.
- No front-end behavior changes.
