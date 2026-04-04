# Local Development

## Prerequisites
- Node.js 20+
- npm
- Supabase project with tables used by this app
- At least one AI provider API key

## Install
```bash
npm install
```

## Environment setup
1. Copy env template:
   ```bash
   cp .env.example .env.local
   ```
2. Set required Supabase variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Set `NEXT_PUBLIC_SUPABASE_ANON_KEY` if browser Supabase config is needed.
4. Add at least one provider key (`OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GROK_API_KEY`/`XAI_API_KEY`, `CLAUDE_API_KEY`).

See `docs/environment-variables.md` for full definitions.

## Run locally
```bash
npm run start:api
```
Open `http://localhost:3000`.

## Apply database migrations (repeatable)
```bash
DATABASE_URL=postgres://... npm run db:migrate
```
Migrations are executed in filename order, tracked in `schema_migrations`, and checksum-verified on rerun.

## Tests and checks
```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run ci:gate
```

## Common troubleshooting
- **"Missing required env var" at runtime**: confirm `.env.local` has Supabase vars and restart dev server.
- **No models/providers returned**: ensure at least one provider API key is set.
- **Upload returns provider ref errors**: upload still works for preview context; provider refs are optional and depend on API keys.
- **Summary not updating**: summary updater is skipped when `OPENAI_API_KEY` is unset.
