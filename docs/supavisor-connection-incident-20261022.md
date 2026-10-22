# Supavisor connection/authentication incident — 2026-10-22

## Observed
- Supavisor reported `DbHandler: Authentication timeout after 15000ms` twice in the inspected period, and `ECHECKOUTFAILED` during the first production migration attempt (run 39869656474).
- The same run succeeded on attempt two; this is intermittent rather than a permanent credential mismatch.
- Supavisor recorded **107 authenticated connections in the 23:09 UTC minute**, during successful production migration retry.
- Vercel recorded hundreds of errors for video reconciliation and Cloudflare 522 origin timeouts in the recent interval. This means reliability problems extend beyond the migration runner.
- Direct SQL diagnostics through the Supabase connector intermittently failed with a connection timeout. Postgres project status showed ACTIVE_HEALTHY, which does not prove connection-level health.
- Live `pg_stat_activity`/pool capacity measurements were unavailable due to those timeouts. Do not assert that database max_connections was exceeded.

## Corrections in this change
1. Read the migration checksum ledger in one query, rather than opening a new psql connection for every historical migration. Keep checksum mismatch protection and ordered execution.
2. Retry only a failed, transient read of that ledger. Never automatically replay uncertain migration application or recording writes.
3. Serialize production migration workflows with a non-cancelling GitHub concurrency group, avoiding overlapping migrations.
4. Extend the existing server-side HTTP client's safe **GET-only** transient retry set to Cloudflare 522 and related gateway/origin failures. Never retry RPC or mutating operations automatically.
5. Add regression tests for 80 historical migrations (expected two connections on no-op), and for a 522 GET recovery vs. a non-retried 522 RPC.

## Production acceptance before declaring incident resolved
- Check `pg_stat_activity` versus `max_connections`, connection states and application names using a working admin connection; inspect Supavisor tenant/pool settings and graphs. The connector is not a substitute for pool resource metrics.
- Compare Supavisor per-minute connection/authentication errors and Vercel `/api/internal/{video-handoffs,runpod-results}` errors before and after deployment.
- Trigger one ordinary migration-only main release, record its exact run ID and confirm a successful migration, ledger integrity, and lack of an authentication storm.
- Exercise concurrent **read-only** application requests, video reconciliation, and mission-dispatch status reads under bounded load. Do not use destructive mission creation or real paid providers as a load probe.
- Confirm a representative real application workflow continues after transient 522 reads and that no write/RPC is duplicated.
- If 522s continue with low application connection count, escalate to Supabase provider support with exact timestamp, project ref and correlation IDs. Do not mask origin outages by increasing client timeouts or loosening mission budgets.

## Scope boundary
This PR reduces a confirmed source of avoidable connection churn. It cannot guarantee the Supavisor service or underlying Supabase origin is healthy. No database settings, secrets, spending authorizations, or persisted mission records are changed.
