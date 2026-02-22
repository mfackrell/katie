# Polyglot Actor Orchestrator

A Next.js 15 starter for multi-model routing with tri-layer memory:

- **Layer 1 (Permanent Memory):** Actor persona from Postgres.
- **Layer 2 (Intermediary Memory):** Rolling summary from Vercel KV.
- **Layer 3 (Ephemeral Memory):** Recent verbatim messages from Postgres.

## Stack

- Next.js App Router
- Tailwind CSS dark UI
- Vercel Postgres (`@vercel/postgres`)
- Vercel KV (`@vercel/kv`)
- AI SDK providers (`@ai-sdk/openai`, `@ai-sdk/google`)

## Run

```bash
npm install
npm run dev
```

Set env vars:

- `POSTGRES_URL`
- `KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`
- `OPENAI_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`
- `MASTER_ROUTER_MODEL` (optional; defaults to `gpt-4o-mini`)

## API

`POST /api/chat`

```json
{
  "actorId": "uuid",
  "chatId": "uuid",
  "message": "How do I fix the mobile menu?"
}
```

Flow:

1. Load actor persona from Postgres.
2. Load summary from KV.
3. Load recent messages from Postgres.
4. Route to best model via `lib/router/master-router.ts`.
5. Stream answer and persist chat messages.

## SQL schema

Use `db/schema.sql` to initialize Vercel Postgres.
