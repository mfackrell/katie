#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

if [[ ! -d "supabase/migrations" ]]; then
  echo "supabase/migrations directory not found" >&2
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT pg_advisory_lock(hashtext('katie_schema_migrations'));" >/dev/null
trap 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT pg_advisory_unlock(hashtext('"'"'katie_schema_migrations'"'"'));" >/dev/null' EXIT

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

shopt -s nullglob
for migration_file in supabase/migrations/*.sql; do
  version="$(basename "$migration_file" .sql)"
  checksum="$(sha256sum "$migration_file" | awk '{print $1}')"

  existing_checksum="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT checksum FROM public.schema_migrations WHERE version = '$version';")"

  if [[ -n "$existing_checksum" ]]; then
    if [[ "$existing_checksum" != "$checksum" ]]; then
      echo "Checksum mismatch for already-applied migration '$version'." >&2
      echo "Applied: $existing_checksum" >&2
      echo "Current: $checksum" >&2
      exit 1
    fi
    echo "Skipping already-applied migration: $version"
    continue
  fi

  echo "Applying migration: $version"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration_file"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO public.schema_migrations (version, checksum) VALUES ('$version', '$checksum');" >/dev/null
  echo "Applied migration: $version"
done
