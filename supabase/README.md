# Supabase assets

This directory contains schema assets for the project.

## Migrations

- `migrations/202604010001_model_pricing.sql`
  - Creates the `model_pricing` table used by automated model-pricing refresh and routing cost metadata.

## Applying migrations

Use your normal Supabase workflow (CLI/CI) to apply these files to your project database.

Example (local/linked project):

```bash
supabase db push
```
