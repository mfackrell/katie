import crypto from 'crypto';
import { verifyGithubWebhookSignature } from './security';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { loadConfig, createLogger, metrics, registry } from '../../../packages/core/src';
import { createDb } from '../../../packages/db/src';
import { GithubConnector } from '../../../packages/github/src';
import { NoopEmbeddingProvider, OpenAIEmbeddingProvider, runFullIndex } from '../../../packages/indexer/src';
import { getFileInputSchema, getNeighborsInputSchema, getSymbolInputSchema, searchInputSchema } from '../../../packages/mcp-contract/src';
import { RetrievalService } from '../../../packages/retrieval/src';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createDb(config.DATABASE_URL);
const github = new GithubConnector(config.GITHUB_TOKEN);
const embedder = config.EMBEDDING_PROVIDER === 'openai' && config.OPENAI_API_KEY
  ? new OpenAIEmbeddingProvider(config.OPENAI_API_KEY, config.EMBEDDING_MODEL)
  : new NoopEmbeddingProvider(config.EMBEDDING_DIM);

const app = Fastify({ logger });
app.register(sensible);
app.register(rateLimit, { max: 100, timeWindow: '1 minute', keyGenerator: (req) => String(req.headers['x-api-key'] ?? req.ip) });

app.addHook('onRequest', async (req, reply) => {
  const requestId = req.headers['x-request-id'] ?? crypto.randomUUID();
  req.headers['x-request-id'] = String(requestId);
  reply.header('x-request-id', String(requestId));

  if (req.url.startsWith('/health') || req.url === '/metrics') return;
  const key = String(req.headers['x-api-key'] ?? '');
  if (!config.apiKeys.has(key)) return reply.unauthorized('invalid api key');
});

app.get('/health/live', async () => ({ status: 'ok' }));
app.get('/health/ready', async () => {
  await db.query('select 1');
  return { status: 'ready' };
});
app.get('/metrics', async (_, reply) => reply.type('text/plain').send(await registry.metrics()));

const parseRepo = (repo: string) => {
  const [owner, name] = repo.split('/');
  return { owner, name };
};

app.post('/admin/repos/connect', async (req) => {
  const body = req.body as { repo: string };
  const { owner, name } = parseRepo(body.repo);
  const info = await github.getRepo(owner, name);
  const row = await db.query(
    `insert into repositories (id, github_owner, github_repo, default_branch)
     values (gen_random_uuid(), $1,$2,$3)
     on conflict (github_owner, github_repo) do update set default_branch = excluded.default_branch
     returning *`,
    [owner, name, info.default_branch]
  );
  return row.rows[0];
});

app.post('/admin/repos/:id/reindex', async (req) => {
  const { id } = req.params as { id: string };
  const body = req.body as { mode: 'full' | 'incremental'; repo: string; branch?: string };
  const { owner, name } = parseRepo(body.repo);
  const branch = body.branch ?? 'main';
  const tree = await github.getTree(owner, name, branch);
  const files = [] as Array<{ path: string; sha: string; size: number; content: string }>;
  for (const entry of tree.tree) {
    if (entry.type !== 'blob' || !entry.path) continue;
    const f = await github.getFile(owner, name, entry.path, branch);
    files.push({ path: entry.path, sha: f.sha, size: f.size, content: f.content });
  }
  const result = await runFullIndex(db, id, files, embedder);
  return { status: 'queued', ...result, commit: tree.sha };
});

app.get('/admin/repos/:id/status', async (req) => {
  const { id } = req.params as { id: string };
  const row = await db.query('select * from repo_sync_runs where repository_id = $1 order by started_at desc limit 1', [id]);
  return row.rows[0] ?? { status: 'never-run' };
});

app.post('/webhooks/github', async (req, reply) => {
  const sig = String(req.headers['x-hub-signature-256'] ?? '');
  const secret = config.GITHUB_WEBHOOK_SECRET ?? '';
  if (!verifyGithubWebhookSignature(JSON.stringify(req.body), sig, secret)) {
    return reply.unauthorized('invalid signature');
  }
  return { accepted: true };
});

app.post('/mcp/tools/search', async (req) => {
  metrics.searchRequestsTotal.inc();
  const end = metrics.searchLatencyMs.startTimer();
  const input = searchInputSchema.parse(req.body);
  const [owner, name] = input.repo.split('/');
  const repo = await db.query('select id, default_branch from repositories where github_owner = $1 and github_repo = $2', [owner, name]);
  const retrieval = new RetrievalService(db);
  const merged = await retrieval.search(repo.rows[0].id, input.query, input.topK, input.pathPrefix);
  end();
  return { results: merged };
});

app.post('/mcp/tools/get_file', async (req) => {
  const input = getFileInputSchema.parse(req.body);
  const [owner, name] = input.repo.split('/');
  const q = await db.query(
    `select f.path, f.sha, fc.content, fc.start_line, fc.end_line from files f
     join repositories r on r.id = f.repository_id
     join file_chunks fc on fc.file_id = f.id
     where r.github_owner = $1 and r.github_repo = $2 and f.path = $3
     order by fc.chunk_index`,
    [owner, name, input.path]
  );
  const lines = q.rows.flatMap((r) => String(r.content).split('\n'));
  const start = input.startLine;
  const end = input.endLine ?? lines.length;
  return { repo: input.repo, path: input.path, sha: q.rows[0]?.sha, content: lines.slice(start - 1, end).join('\n'), startLine: start, endLine: end };
});

app.post('/mcp/tools/get_symbol', async (req) => {
  const input = getSymbolInputSchema.parse(req.body);
  const [owner, name] = input.repo.split('/');
  const q = await db.query(
    `select f.path, s.*, fc.content from symbols s
     join files f on f.id = s.file_id
     join repositories r on r.id = f.repository_id
     left join file_chunks fc on fc.file_id = f.id and fc.start_line <= s.start_line and fc.end_line >= s.end_line
     where r.github_owner = $1 and r.github_repo = $2 and s.name ilike $3
       and ($4::text is null or f.path like ($4 || '%'))
     limit 20`,
    [owner, name, `%${input.symbol}%`, input.pathHint ?? null]
  );
  return {
    matches: q.rows.map((r) => ({ path: r.path, symbol: { name: r.name, kind: r.kind, startLine: r.start_line, endLine: r.end_line, signature: r.signature }, snippet: r.content ?? '', score: 1 }))
  };
});

app.post('/mcp/tools/get_neighbors', async (req) => {
  const input = getNeighborsInputSchema.parse(req.body);
  const [owner, name] = input.repo.split('/');
  const q = await db.query(
    `with base as (
       select fc.file_id, fc.chunk_index from file_chunks fc where fc.id = $1
     )
     select fc.id, f.path, fc.start_line, fc.end_line, fc.content from file_chunks fc
     join files f on f.id = fc.file_id
     join repositories r on r.id = f.repository_id
     join base b on b.file_id = fc.file_id
     where r.github_owner = $2 and r.github_repo = $3 and f.path = $4
       and fc.chunk_index between b.chunk_index - $5 and b.chunk_index + $5
     order by fc.chunk_index`,
    [input.chunkId, owner, name, input.path, input.radius]
  );
  return { neighbors: q.rows };
});

const start = async () => {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
};

start();

const shutdown = async () => {
  await app.close();
  await db.end();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
