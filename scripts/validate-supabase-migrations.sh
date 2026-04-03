#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${SUPABASE_PROJECT_REF:-}" ]]; then
  echo "SUPABASE_PROJECT_REF must be set for migration validation." >&2
  exit 1
fi

if [[ -z "${SUPABASE_DB_PASSWORD:-}" ]]; then
  echo "SUPABASE_DB_PASSWORD must be set for migration validation." >&2
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

migration_list_output="$(supabase migration list --linked --password "$SUPABASE_DB_PASSWORD")"

missing=()
for version in "${local_versions[@]}"; do
  if ! grep -qE "(^|[^0-9])${version}([^0-9]|$)" <<<"$migration_list_output"; then
    missing+=("$version")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Remote Supabase project ${SUPABASE_PROJECT_REF} is missing migrations present in repo: ${missing[*]}" >&2
  echo "Run: supabase db push --include-all" >&2
  exit 1
fi

echo "Remote Supabase migration history matches all repository migration files."
