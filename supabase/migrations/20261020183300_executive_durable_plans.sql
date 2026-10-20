-- Executive management plans are independent of ordinary chat generation.
alter table public.executive_management_requests
  add column if not exists plan jsonb;
alter table public.executive_management_requests
  drop constraint if exists executive_management_requests_status_check;
alter table public.executive_management_requests
  add constraint executive_management_requests_status_check
  check(status in ('received','planning','running','delegated','blocked','completed'));
create index if not exists executive_management_pending
  on public.executive_management_requests(status,updated_at)
  where status in ('received','planning','running');
