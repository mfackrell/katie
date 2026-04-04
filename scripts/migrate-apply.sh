#!/usr/bin/env bash
set -euo pipefail

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required to apply migrations." >&2
  exit 1
fi

DATABASE_URL_VALUE="${DATABASE_URL:-}"
if [[ -z "$DATABASE_URL_VALUE" ]]; then
  echo "DATABASE_URL is required (example: postgres://postgres:postgres@127.0.0.1:5432/app)." >&2
  exit 1
fi

shopt -s nullglob
migrations=(supabase/migrations/*.sql)

if [[ ${#migrations[@]} -eq 0 ]]; then
  echo "No SQL migrations found in supabase/migrations/."
  exit 0
fi

for migration in "${migrations[@]}"; do
  echo "Applying ${migration}"
  psql "$DATABASE_URL_VALUE" -v ON_ERROR_STOP=1 -f "$migration"
done

echo "Migrations applied successfully."
