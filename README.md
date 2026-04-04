# Repo Index MCP (Read-only MVP)

Production-minded MVP for repository indexing + retrieval for AI assistants.

## Assumptions
- Incremental mode currently accepts webhook payload and reindexes changed files only if file list is present; otherwise it falls back to full reindex.
- Symbol extraction is regex fallback only (language-aware parser can replace later).
- Vector retrieval currently uses zero-vector query unless an embedding query provider is wired for search-time embeddings.
- This MVP is read-only with GitHub scopes limited to metadata/contents.

## Project tree
- `apps/api` Fastify API with MCP + admin + webhook endpoints.
- `apps/worker` BullMQ worker and dead-letter handling.
- `packages/core` config/retry/logging/metrics.
- `packages/db` Postgres client and idempotent upserts.
- `packages/github` Octokit connector.
- `packages/indexer` chunking/symbol extraction/embeddings/pipeline.
- `packages/retrieval` keyword+vector hybrid ranking.
- `packages/mcp-contract` Zod contracts for tools.
- `migrations` SQL schema + pgvector.
- `docker` Dockerfiles for API/worker.

## Local setup
1. Copy env and update secrets:
   ```bash
   cp .env.example .env
   ```
2. Start stack:
   ```bash
   docker compose up --build
   ```
3. API live/ready:
   - `GET http://localhost:3000/health/live`
   - `GET http://localhost:3000/health/ready`
4. Metrics:
   - `GET http://localhost:3000/metrics`

## Environment variables
See `.env.example` for required values:
- `PORT`, `DATABASE_URL`, `REDIS_URL`, `API_KEYS`
- `GITHUB_AUTH_MODE`, `GITHUB_TOKEN`
- `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`
- `EMBEDDING_PROVIDER`, `OPENAI_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_DIM`
- `LOG_LEVEL`

## Connect repo
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

## MCP tool examples
### search
```bash
curl -X POST http://localhost:3000/mcp/tools/search \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"repo":"owner/name","query":"syncPricing","topK":10}'
```

### get_file
```bash
curl -X POST http://localhost:3000/mcp/tools/get_file \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"repo":"owner/name","path":"src/app.ts","startLine":1,"endLine":200}'
```

### get_symbol
```bash
curl -X POST http://localhost:3000/mcp/tools/get_symbol \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"repo":"owner/name","symbol":"syncPricing"}'
```

### get_neighbors
```bash
curl -X POST http://localhost:3000/mcp/tools/get_neighbors \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"repo":"owner/name","path":"src/pricing/sync.ts","chunkId":"00000000-0000-0000-0000-000000000000","radius":2}'
```

## Troubleshooting
- **401 invalid api key**: confirm `x-api-key` value is listed in `API_KEYS`.
- **Webhook signature invalid**: verify raw JSON body and `GITHUB_WEBHOOK_SECRET` match sender.
- **No vector matches**: set `EMBEDDING_PROVIDER=openai` and configure `OPENAI_API_KEY`.
- **Rate limiting**: increase limits in Fastify rate-limit plugin for local load tests.

## Security notes
- Keep GitHub integration read-only (`contents:read`, `metadata:read`).
- Do not log tokens or secrets.
- Validate all endpoint payloads with Zod.
- Enforce API key auth + per-key rate limits.
