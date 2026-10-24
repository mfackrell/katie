# Production database migration authority

**Sole automated production writer:** GitHub Actions `.github/workflows/migrate.yml` invoking `scripts/run-migrations.mjs` on main. The authoritative file/checksum ledger is `public.schema_migrations`.

**Do not enable Supabase's GitHub integration 'Deploy to production' alongside this runner.** If GitHub is connected for previews, leave native production auto-deploy disabled. One migration writer per production database.

The database also contains `supabase_migrations.schema_migrations` populated by prior direct Supabase operations. Preserve this as historical evidence. Its migration versions do not match repo versions. Do not translate names into new history records, delete entries, or replay migrations as a synchronization shortcut.

Read-only reconciliation: run `node scripts/audit-migration-authority.mjs` with the existing secret DATABASE_URL in a protected CI environment. It verifies every currently committed SQL filename and SHA-256 checksum against the authoritative ledger and reports native history separately. It exits nonzero for missing or mismatched committed files. Existing historical-only ledger entries are retained.

Verified aliases from production inspection (exist in both histories under different versions, but their SQL execution equivalence is NOT proved by the name alone):

| Native version | Native name | Repository SQL |
| --- | --- | --- |
| 20261023184205 | message_reactions | 20261023180000_message_reactions.sql |
| 20261023190845 | actor_reaction_events | 20261023194500_actor_reaction_events.sql |
| 20261023202710 | reaction_reply_jobs | 20261023205000_reaction_reply_jobs.sql |

Before any future switch to native deployment tooling, create a separately reviewed, checksum-verified version mapping for **all** historical entries, confirm the live catalog objects and function definitions, reconcile history transactionally with backup/rollback procedures, disable the existing writer, then enable the replacement. Do not operate both writers concurrently.
