import { Counter, Histogram, Registry } from 'prom-client';

export const registry = new Registry();

export const metrics = {
  syncRunsTotal: new Counter({
    name: 'sync_runs_total',
    help: 'Sync runs by status and mode',
    labelNames: ['status', 'mode'],
    registers: [registry]
  }),
  filesIndexedTotal: new Counter({
    name: 'files_indexed_total',
    help: 'Indexed files total',
    registers: [registry]
  }),
  chunksIndexedTotal: new Counter({
    name: 'chunks_indexed_total',
    help: 'Indexed chunks total',
    registers: [registry]
  }),
  searchRequestsTotal: new Counter({
    name: 'search_requests_total',
    help: 'Total search requests',
    registers: [registry]
  }),
  searchLatencyMs: new Histogram({
    name: 'search_latency_ms',
    help: 'Search latency ms',
    buckets: [10, 50, 100, 300, 500, 1000],
    registers: [registry]
  }),
  githubRateRemaining: new Counter({
    name: 'github_api_rate_remaining',
    help: 'Observed remaining github calls',
    registers: [registry]
  })
};
