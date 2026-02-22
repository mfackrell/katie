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

## Where the UI lives (no `index.html` in Next.js App Router)

This project uses **Next.js App Router**, so you typically do not author a root `index.html` file manually.

- `app/layout.tsx` is the root HTML shell (it renders `<html>` and `<body>`).
- `app/page.tsx` is the `/` route UI (equivalent to a homepage entrypoint).
- `app/globals.css` contains global styles.

At build/runtime, Next.js generates the final HTML for each route from these files.

## Run

```bash
npm install
npm run dev
```

Set env vars in a local environment file:

1. Create `/.env.local` at the repository root (same level as `package.json`).
2. Copy values from `.env.example` and fill in your real secrets.
3. Never commit real API keys to git.

Required keys:

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
