# Polyglot Actor Orchestrator

Cloud-first Next.js (App Router) interface for multi-model chat orchestration with tri-layer memory:

- **Layer 1 (Permanent)**: Actor persona loaded from Blob-backed actor documents.
- **Layer 2 (Intermediary)**: Rolling summary document per chat.
- **Layer 3 (Ephemeral)**: Recent raw messages (latest 20) per chat.

## Architecture

- `app/api/chat/route.ts`: master orchestration endpoint.
- `lib/router/master-router.ts`: provider choice logic (manual override + LLM-assisted routing + fallback).
- `lib/providers/*`: provider interface + OpenAI/Gemini providers.
- `lib/memory/*`: context assembly and summary updates.
- `lib/data/blob-store.ts`: Blob-backed JSON persistence adapters.

## Vercel-only deployment workflow

1. Push this repo to GitHub.
2. Import into Vercel.
3. Configure Blob variables:
   - `BLOB_BASE_URL` (public blob base URL where JSON files are read)
   - `BLOB_WRITE_TOKEN` (token allowed to write updated summaries/messages)
4. Add API keys in Vercel env vars using secrets.

### Secret Manager for API keys

```bash
vercel secrets add openai_api_key "<your-openai-key>"
vercel secrets add google_api_key "<your-google-key>"
```

Then map in Vercel Project Settings → Environment Variables:

- `OPENAI_API_KEY=@openai_api_key`
- `GOOGLE_API_KEY=@google_api_key`

## Blob object layout

- `actors/<actor-id>.json`
- `messages/<chat-id>.json`
- `summaries/<chat-id>.json`

If blob docs are missing, the app falls back to in-memory/session defaults for development previews.

## Local validation commands

```bash
npm run typecheck
npm run lint
npm run build
```
