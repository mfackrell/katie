# Supabase migration incident: PR #225

## What was wrong

PR #225 introduced `supabase/migrations/202604030001_model_registry.sql`, but there was no GitHub Actions workflow in this repository to apply migrations on merge to `main`.

As a result, merging PR #225 updated application code to depend on `model_registry`, while the linked Supabase project never received the SQL migration.

## Why the action did not run

There was no tracked workflow file under `.github/workflows/` to trigger on `push` to `main` for `supabase/migrations/**`. With no workflow definition present in git, GitHub had nothing to execute for PR #225.

## What was changed

1. Added `.github/workflows/supabase-migrations.yml`:
   - Triggers on `push` to `main` when migration pipeline files change.
   - Supports manual `workflow_dispatch` for emergency backfills.
   - Runs `supabase db push --include-all` against `secrets.SUPABASE_DB_URL`.
2. Added `scripts/validate-supabase-migrations.sh`:
   - Compares local migration versions from `supabase/migrations/*.sql` to `supabase_migrations.schema_migrations` in the remote database.
   - Fails CI if any repo migration version is missing remotely.

## How this fixes PR #225 specifically

When this change is merged to `main`, the migration workflow runs and executes `supabase db push --include-all`, which applies any unapplied historical migrations including:

- `202604030001_model_registry.sql`
- `202604030002_model_registry_ops_tables.sql`

Then validation verifies those versions exist in remote migration history; deployment fails if not.

## Operational requirement

Repository secret `SUPABASE_DB_URL` must be configured to the linked Supabase Postgres connection string (with privileges to apply migrations and read `supabase_migrations.schema_migrations`).
