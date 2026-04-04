# Operations Runbook

## Migration apply command (beyond initdb mount)
Use the migration apply script to execute every SQL file in `supabase/migrations` against a live database.

```bash
export DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/katie'
npm run migrate:apply
```

Notes:
- Requires `psql` in your runtime image/host.
- Applies files in lexical order.
- Fails fast on first SQL error (`ON_ERROR_STOP=1`).

## API and worker start commands
Use the API launcher for local or production mode and run the model-registry worker separately.

```bash
# API (development)
npm run start:api

# API (production)
NODE_ENV=production npm run start:api

# Worker (periodic model-registry refresh)
INTERNAL_API_TOKEN=change-me npm run start:worker
```

Worker variables:
- `WORKER_API_BASE_URL` (default `http://127.0.0.1:3000`)
- `MODEL_REGISTRY_REFRESH_INTERVAL_SECONDS` (default `300`)
- `INTERNAL_API_TOKEN` (required)

## MCP endpoint smoke tests
Run smoke checks against all shipped MCP-facing API routes.

```bash
# Base MCP smoke test set
MCP_BASE_URL=http://127.0.0.1:3000 npm run smoke:mcp

# Include internal refresh endpoint check
MCP_BASE_URL=http://127.0.0.1:3000 INTERNAL_API_TOKEN=change-me npm run smoke:mcp
```

The smoke runner verifies:
- `GET /api/models`
- `GET /api/actors`
- `GET /api/chats`
- `GET /api/messages`
- `POST /api/chat`
- `POST /api/long-term-memory`
- `POST /api/internal/model-registry/refresh` (when `INTERNAL_API_TOKEN` is set)

## Rollback and incident steps
### Fast rollback
1. Roll back application artifact to the last known-good release.
2. If migrations were deployed, restore DB from the latest pre-deploy snapshot.
3. Disable worker refresh loop by stopping `start:worker` process or clearing scheduler job.

### Incident troubleshooting checklist
1. **API failing startup**: confirm `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set.
2. **Model routing degraded**: validate provider API keys and run internal refresh endpoint manually.
3. **High latency**: disable `ROUTER_TRACE_ENABLED` and check provider-specific rate limits.
4. **Auth failures on internal refresh**: verify `x-internal-token` matches `INTERNAL_API_TOKEN`.
5. **Data writes failing**: validate DB connectivity and rerun `npm run migrate:apply` against target DB.
