# Katie (Polyglot Actor Orchestrator).

Katie is a Next.js App Router application for multi-provider AI chat with actor personas, model routing, file attachments, and durable conversation memory.

It solves a practical orchestration problem: keep one chat UI while dynamically selecting models/providers and preserving context across chats and actors.

## Start here
1. Read [`docs/local-development.md`](docs/local-development.md) for setup.
2. Review [`docs/environment-variables.md`](docs/environment-variables.md) for required configuration.
3. Skim [`docs/architecture.md`](docs/architecture.md) and [`docs/data-model.md`](docs/data-model.md) for system internals.
4. Read [`docs/deployment.md`](docs/deployment.md) for migration-first rollout guidance.
5. Review [`docs/attachments.md`](docs/attachments.md) for supported upload types and extraction caveats.

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
curl -X POST http://localhost:3000/admin/repos/connect \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"repo":"owner/name"}'
```

## Trigger reindex
```bash
curl -X POST http://localhost:3000/admin/repos/<repo_id>/reindex \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"mode":"full","repo":"owner/name","branch":"main"}'
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
- `npm run start` / `npm run start:runtime` – run production server via explicit compiled Next.js runtime entry.
- `npm run lint` – Next.js lint.
- `npm run typecheck` – TypeScript check.
- `npm test` – unit/integration test suite.
- `npm run check:url` – repo guard for legacy URL usage.
- `npm run db:migrate` – apply SQL migrations in deterministic order with checksum tracking (`DATABASE_URL` required).
- `npm run smoke` – production startup smoke check against built output.
- `npm run ci:gate` – required release gate (`test` + URL guard + build + smoke).

## Production deployment migration requirement
- Production deploys must run `npm run db:migrate` against the production `DATABASE_URL` before application rollout.
- This repository enforces that ordering via `.github/workflows/migrate.yml` (`migrate` job runs first, `deploy_vercel` requires `needs: migrate`).
- Ensure `PRODUCTION_DATABASE_URL` in GitHub Actions points to the live production database.

### get_file
```bash
curl -X POST http://localhost:3000/mcp/tools/get_file \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"repo":"owner/name","path":"src/app.ts","startLine":1,"endLine":200}'
```

### get_symbol
```bash
npm run typecheck
npm run lint
npm run build
npm run smoke
```

### get_neighbors
```bash
curl -X POST http://localhost:3000/mcp/tools/get_neighbors \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"repo":"owner/name","path":"src/pricing/sync.ts","chunkId":"00000000-0000-0000-0000-000000000000","radius":2}'
```

## Historical note
Earlier documentation referenced blob-based JSON storage. The current implementation is Supabase-based and docs here reflect that current state.

## Production environment matrix
| Variable | Required | Scope | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | API + browser | Supabase endpoint used by app clients. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | API/server only | Privileged DB operations via PostgREST admin client. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Recommended | Browser | Browser-side Supabase operations. |
| `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `GROK_API_KEY` / `CLAUDE_API_KEY` | At least one | API/server only | Provider connectivity for model responses. |
| `INTERNAL_API_TOKEN` | Required for internal refresh + worker | API + worker | Auth token for `/api/internal/model-registry/refresh`. |
| `ROUTER_*` flags | Optional | API/server only | Router diagnostics and policy tuning. |

## Secret management guidance
- Store all non-public secrets in deployment secret stores (for example, GitHub Actions Secrets / Vercel encrypted env vars / cloud secret manager).
- Never commit provider keys, Supabase service role keys, or `INTERNAL_API_TOKEN` into git.
- Use different credentials per environment (dev/staging/prod) and rotate credentials after any suspected exposure.
- Restrict access to production secrets to least privilege on-call/admin roles only.

## Rollback and incident troubleshooting
- Operational rollback and incident runbook is documented in [`docs/operations-runbook.md`](docs/operations-runbook.md).
- Include `npm run smoke:mcp` in post-rollback validation before reopening traffic.
- For DB-impacting incidents, restore a snapshot first, then rerun `npm run migrate:apply` only after change review.
