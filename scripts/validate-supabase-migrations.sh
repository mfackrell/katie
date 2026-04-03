#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
  echo "SUPABASE_DB_URL must be set for migration validation." >&2
  exit 1
fi

if [[ ! -d "supabase/migrations" ]]; then
  echo "supabase/migrations directory not found." >&2
  exit 1
fi

mapfile -t local_versions < <(
  find supabase/migrations -maxdepth 1 -type f -name '*.sql' \
    | sed -E 's|.*/([0-9]+)_.*\.sql|\1|' \
    | sort -u
)

if [[ ${#local_versions[@]} -eq 0 ]]; then
  echo "No local migration files found under supabase/migrations." >&2
  exit 1
fi

mapfile -t remote_versions < <(
  psql "$SUPABASE_DB_URL" -X -A -t -c "select version::text from supabase_migrations.schema_migrations order by version;"
)

missing=()
for version in "${local_versions[@]}"; do
  if ! printf '%s\n' "${remote_versions[@]}" | grep -qx "$version"; then
    missing+=("$version")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Remote Supabase project is missing migrations present in repo: ${missing[*]}" >&2
  echo "Run: supabase db push --db-url \"\$SUPABASE_DB_URL\" --include-all" >&2
  exit 1
fi

echo "Remote Supabase migration history matches all repository migration files."
