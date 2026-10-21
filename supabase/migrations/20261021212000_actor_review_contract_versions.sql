-- Immutable per-application review contract versions.
-- Version 1 retains the original source fingerprint for backwards compatibility.
alter table public.actor_review_contracts
  add column if not exists requirements_revision integer not null default 1;
alter table public.actor_review_contracts
  add constraint actor_review_contract_revision_positive check (requirements_revision > 0);
create index if not exists actor_review_contract_versions
  on public.actor_review_contracts(actor_id,project_source_id,objective_source_id,requirements_revision desc,created_at desc);
