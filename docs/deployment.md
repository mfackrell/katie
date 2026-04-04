# Deployment and Rollout Order

This project should deploy with a **repeatable migration step** that runs before application containers start serving traffic.

## Deterministic runtime commands
Use explicit Node entrypoints in containers instead of implicit package manager resolution.

- API runtime command: `node --disable-warning=DEP0169 ./node_modules/next/dist/bin/next start -p 3000`
- Worker runtime command: `node --disable-warning=DEP0169 ./node_modules/next/dist/bin/next start -p 3001`

This avoids environment-dependent command resolution and keeps runtime startup deterministic.

## Repeatable migration strategy
Do **not** rely only on one-time `initdb` mounts.

Use `scripts/run-migrations.sh`, which:
- Creates `public.schema_migrations` if it does not exist.
- Acquires a PostgreSQL advisory lock so only one migrator runs at a time.
- Applies SQL files in `supabase/migrations/*.sql` in filename order.
- Stores checksum + version for each applied migration.
- Fails fast if a previously applied migration file was modified.

This strategy is safe for repeated deploys and concurrent rollout attempts.

## Docker Compose rollout order
The deployment sequence should always be:

1. **Migrate**
   ```bash
   docker compose run --rm migrate
   ```
2. **Start API + worker**
   ```bash
   docker compose up -d api worker
   ```
3. **Wait for health checks**
   ```bash
   docker compose ps
   ```
   Confirm both `api` and `worker` are `healthy` before routing traffic.

## CI/CD recommendation
In CI/CD pipelines, use separate stages/jobs with hard ordering:

1. `migrate`
2. `deploy api + worker`
3. `verify health`

If step 1 fails, do not deploy runtime services.
