# Katie (Polyglot Actor Orchestrator).

Katie is a Next.js App Router application for multi-provider AI chat with actor personas, model routing, file attachments, and durable conversation memory.

It solves a practical orchestration problem: keep one chat UI while dynamically selecting models/providers and preserving context across chats and actors.

## Start here
1. Read [`docs/local-development.md`](docs/local-development.md) for setup.
2. Review [`docs/environment-variables.md`](docs/environment-variables.md) for required configuration.
3. Skim [`docs/architecture.md`](docs/architecture.md) and [`docs/data-model.md`](docs/data-model.md) for system internals.
4. Read [`docs/deployment.md`](docs/deployment.md) for migration-first rollout guidance.

## Tech stack (actual)
- **Framework:** Next.js 15 (App Router), React 18, TypeScript.
- **Validation:** Zod.
- **AI SDKs/APIs:** OpenAI, Google GenAI, xAI (OpenAI-compatible), Anthropic.
- **Persistence:** Supabase (PostgREST access via service role key).
- **Styling:** Tailwind CSS.
- **Tests:** Node test runner (`node --test`) + TypeScript-compiled tests.

## Architecture overview
- **Frontend:** `app/page.tsx` + `components/*` (actor/chat management and chat panel).
- **API layer:** `app/api/*` routes for actors, chats, messages, models, uploads, and chat generation.
- **Routing/selection:** `lib/router/*` combines heuristics and policy flags.
- **Canonical model registry:** `lib/models/registry.ts` is the single metadata/routing source of truth populated by discovery + enrichment.
- **Provider adapters:** `lib/providers/*` normalize OpenAI/Google/Grok/Anthropic APIs.
- **Memory:** `lib/memory/*` assembles short/intermediate/long-term context and rolling summaries.
- **Persistence:** `lib/data/persistence-store.ts` reads/writes Supabase tables.

## Persistence and storage
This repo uses **Supabase-backed persistence** (actors, chats, messages, and memory tables). It does **not** use blob-backed JSON persistence in current code.

See [`docs/data-model.md`](docs/data-model.md) for table/entity details.

## Providers supported (high level)
- OpenAI
- Google Gemini
- xAI Grok
- Anthropic Claude

Providers are enabled by whichever API keys are present at runtime. `/api/models` now returns registry-backed model metadata (not raw provider lists only).

## Canonical model registry and automated routing
- Discovery source: provider `listModels()` for each configured provider.
- Persistence: `model_registry` table (see `supabase/migrations/202604030001_model_registry.sql`).
- Enrichment: pricing catalog (LiteLLM dataset when available) + conservative heuristics fallback.
- Eligibility states:
  - `verified` – strong metadata confidence and pricing/capability evidence.
  - `restricted` – usable for lower-risk/general routing with conservative defaults.
  - `manual_override_only` – not in automatic pool; still reachable through explicit override.
  - `disabled` – excluded from routing.
- Router behavior:
  - Automatic selection consumes registry eligibility first.
  - Missing registry snapshot falls back to provider model lists with warning logs.
  - Unknown/weak models are not silently promoted to premium specialized routing.

### Background refresh job
- Protected endpoint: `POST /api/internal/model-registry/refresh`
- Auth: header `x-internal-token: <INTERNAL_API_TOKEN>`
- Designed for cron invocation to keep discovery/enrichment current.

## Local development
### Prerequisites
- Node.js 20+
- npm
- Supabase project with schema expected by this app
- At least one provider API key

### Setup
```bash
npm install
cp .env.example .env.local
```
Populate `.env.local` (see [`docs/environment-variables.md`](docs/environment-variables.md)).

### Run
```bash
npm run dev
```
App runs on `http://localhost:3000` by default.

## Required environment variables
Minimum required for app boot + persistence:
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Recommended for browser client config:
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

At least one provider key is required for chat generation:
- `OPENAI_API_KEY` and/or `GOOGLE_API_KEY` and/or `GROK_API_KEY` (`XAI_API_KEY`/`grok_api_key` also supported) and/or `CLAUDE_API_KEY` (`claude_api_key` also supported).

Full list: [`docs/environment-variables.md`](docs/environment-variables.md).

## Scripts
- `npm run dev` – start local dev server.
- `npm run build` – production build.
- `npm run start` – run production server.
- `npm run lint` – Next.js lint.
- `npm run typecheck` – TypeScript check.
- `npm test` – unit/integration test suite.
- `npm run check:url` – repo guard for legacy URL usage.

## Testing
Run all tests:
```bash
npm test
```

Additional checks:
```bash
npm run typecheck
npm run lint
npm run build
```

Details: [`docs/testing.md`](docs/testing.md).

## Deployment overview
- Designed for standard Next.js deployment targets (including Vercel).
- Requires Supabase environment variables and provider API keys in the deployment environment.
- No blob storage configuration is required by current code.

## Repo structure (concise)
- `app/` – Next.js app + API routes.
- `components/` – UI components.
- `lib/data/` – persistence and Supabase helpers.
- `lib/router/` – routing and policy selection logic.
- `lib/providers/` – provider integrations.
- `lib/memory/` – memory assembly + summarization.
- `lib/uploads/` – upload parsing/provider reference helpers.
- `tests/` – Node/TS test suite.
- `docs/` – developer documentation.

## Known caveats
- Summary generation (`lib/memory/summarizer.ts`) currently depends on `OPENAI_API_KEY`; without it, summary updates are skipped.
- Video attachments are routed to Google provider path in this chat flow.
- Some provider API keys have backward-compatible alias env vars for legacy compatibility.

## Historical note
Earlier documentation referenced blob-based JSON storage. The current implementation is Supabase-based and docs here reflect that current state.
